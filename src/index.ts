/**
 * Service entrypoint.
 *
 * Order matters: configuration is validated before anything else, so a
 * missing variable is a clean startup failure naming the variable rather than
 * an obscure error later on.
 */

import type { Db } from 'mongodb';

import {
  loadConfig,
  loadNeutaraConfig,
  loadOpenAiConfig,
  loadOperatorConfig,
  loadWebhookConfig,
  resolveDatabaseName,
  resolveRuntimeMongoUri,
  describeNeutaraStartup,
  ConfigError,
} from './config/env.ts';
import { DATABASE_NAME, createConnectionManager } from './db/client.ts';
import { createAuditLog, type AuditLog } from './db/audit-log.ts';
import { createWebhookDeliveryRepository } from './db/webhook-deliveries.ts';
import { createIntakeRepository } from './intake/repository.ts';
import { createTestTicketPurger } from './intake/test-purge.ts';
import { createTestRegistryDeleter } from './repository-registry/test-delete.ts';
import { createNeutaraClient } from './neutara/client.ts';
import { startEnrichmentLoop, type EnrichmentLoop } from './enrichment/scheduler.ts';
import { createRunsRepository } from './orchestrator/repository.ts';
import { startOrchestratorLoop, type OrchestratorLoop } from './orchestrator/scheduler.ts';
import { createRepositoryRegistryRepository } from './repository-registry/repository.ts';
import { createRepositorySelectionRepository, createSelectionQueueQueries } from './repository-selection/repository.ts';
import {
  startRepositorySelectionLoop,
  type RepositorySelectionLoop,
} from './repository-selection/scheduler.ts';
import { createRequirementsRepository } from './requirements/repository.ts';
import { startRequirementsLoop, type RequirementsLoop } from './requirements/scheduler.ts';
import { createLlmRequirementsAnalyzer } from './requirements/openai-analyzer.ts';
import type { RequirementsResult } from './requirements/analyzer.ts';
import type { IntakeSnapshot } from './intake/repository.ts';
import { loadGitHubAppConfig } from './github-app/config.ts';
import { createTokenIssuer } from './github-app/token-issuer.ts';
import { createRealGitHubAppClient } from './github-app/real-client.ts';
import type { GitHubAppClient } from './github-app/client.ts';
import { createGitHubAccessService, type GitHubAccessDeps, type GitHubAccessService } from './github-access/service.ts';
import { createCodingAgentService, type CodingAgentService } from './coding-agent/service.ts';
import { createMockCodingAgentProvider } from './coding-agent/provider.ts';
import { createOpenAiCodingAgentProvider } from './coding-agent/openai-provider.ts';
import { createRepositoryContextDeps } from './coding-agent/repository-context.ts';
import { createHeuristicFileSuggester, createOpenAiFileSuggester } from './coding-agent/file-suggestion.ts';
import type { CodingAgentProvider } from './coding-agent/provider.ts';
import { createChangeReviewQueueQueries, createChangeReviewRepository } from './change-execution/review-repository.ts';
import { createChangeExecutionRepository } from './change-execution/execution-repository.ts';
import { createChangeExecutionService, type ChangeExecutionService } from './change-execution/execution-service.ts';
import { createMockChangeValidationRunner } from './change-execution/validation.ts';
import { createGithubPublicationRepository } from './github-publish/publish-repository.ts';
import { createGithubPublishService, type GithubPublishService } from './github-publish/publish-service.ts';
import { createDeploymentRepository } from './deployment/deployment-repository.ts';
import { createMockDeploymentProvider } from './deployment/deployment-provider.ts';
import { createMockPostDeploymentValidator } from './deployment/post-deployment-validator.ts';
import { createDeploymentService, type DeploymentService } from './deployment/deployment-service.ts';
import { startPipelineLoop, type PipelineLoop } from './pipeline/scheduler.ts';
import { createLogger, type Logger } from './logging/logger.ts';
import { createHttpServer } from './api/server.ts';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const bootLogger = createLogger({ level: 'info' });

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Names the variables, never the values.
      bootLogger.error('startup aborted: invalid configuration', {
        variables: error.variables,
        detail: error.message,
      });
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const logger = createLogger({
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    base: { service: 'aisdlc-service', env: config.nodeEnv, version: VERSION },
  });

  // Which database, decided before anything connects. Outside production the
  // override is mandatory, so a local run cannot default into `aisdlc`.
  const target = resolveDatabaseName(process.env, config.nodeEnv, DATABASE_NAME);
  if (!target.ok) {
    logger.error('startup aborted: unsafe database target', { detail: target.reason });
    process.exitCode = 78; // EX_CONFIG
    return;
  }
  // Which credential, decided independently of which database. Outside
  // production this can never be the production identity (`aisdlc_app`),
  // even though AISDLC_DATABASE_NAME already points elsewhere — the two used
  // to be conflated, which is how the service ended up authenticating as
  // aisdlc_app against aisdlc_test and failing at query time instead of here.
  const credential = resolveRuntimeMongoUri(process.env, config.nodeEnv, config.mongodbUri);
  if (!credential.ok) {
    logger.error('startup aborted: unsafe mongodb credential', { detail: credential.reason });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  logger.info('database target resolved', {
    database: target.databaseName,
    overridden: target.overridden,
    identity: credential.identity,
  });

  // Non-blocking: the server starts serving immediately and reports itself
  // not-ready until the connection lands. A failed first attempt is retried
  // with backoff rather than leaving the instance permanently unready.
  const mongo = createConnectionManager({
    uri: credential.uri,
    logger,
    databaseName: target.databaseName,
  });
  mongo.start();

  const { webhookSecret } = loadWebhookConfig(process.env);
  if (webhookSecret === undefined) {
    // Mounted anyway, answering 401: refusing to start would take the health
    // endpoints down with it, and .env.example specifies refusal per request.
    logger.warn('NEUTARA_WEBHOOK_SECRET is not set; /ingest will reject every request');
  } else {
    // Confirms configuration without ever logging the secret itself.
    logger.info('NEUTARA_WEBHOOK_SECRET is set; /ingest will verify signed requests');
  }

  const { operatorToken } = loadOperatorConfig(process.env);
  if (operatorToken === undefined) {
    // Same "mounted anyway, answers 401" choice as the webhook secret above.
    logger.warn('OPERATOR_TOKEN is not set; the approval endpoints will reject every request');
  }

  // GitHub Access / Coding Agent / Change Execution / GitHub Publish all sit
  // downstream of a real GitHub App client. Absent configuration is valid
  // (mirrors loadNeutaraConfig/loadOpenAiConfig): those routes and loops are
  // simply not mounted/started, the same "disabled, not fatal" choice
  // enrichment already makes for a missing Neutara config. No credential of
  // any kind is ever logged — see github-app/config.ts's own module comment.
  const githubAppConfig = loadGitHubAppConfig(process.env);
  let githubClient: GitHubAppClient | undefined;
  if (!githubAppConfig.configured) {
    logger.warn('GitHub App integration disabled', { detail: githubAppConfig.reason });
  } else {
    const tokenIssuer = createTokenIssuer({
      appId: githubAppConfig.config.appId,
      privateKey: githubAppConfig.config.privateKey,
      logger,
    });
    githubClient = createRealGitHubAppClient({
      appId: githubAppConfig.config.appId,
      privateKey: githubAppConfig.config.privateKey,
      tokenIssuer,
      logger,
    });
  }

  // Requirements Agent and Coding Agent share the same OpenAI configuration
  // group and the same "absent means use the deterministic stub/mock"
  // posture — see loadOpenAiConfig's own module comment.
  const openAiConfig = loadOpenAiConfig(process.env);
  let requirementsAnalyze: ((snapshot: IntakeSnapshot) => Promise<RequirementsResult>) | undefined;
  let codingAgentProvider: CodingAgentProvider = createMockCodingAgentProvider();
  if (!openAiConfig.configured) {
    logger.warn('OpenAI integration disabled', { detail: openAiConfig.reason });
  } else {
    requirementsAnalyze = createLlmRequirementsAnalyzer({
      apiKey: openAiConfig.config.apiKey,
      model: openAiConfig.config.model,
      logger,
    });
    codingAgentProvider = createOpenAiCodingAgentProvider({
      apiKey: openAiConfig.config.apiKey,
      model: openAiConfig.config.model,
      logger,
    });
  }

  /** Every read GitHubAccessService needs, built fresh per call — see the `get` pattern every route below already uses. */
  function buildGitHubAccessDeps(db: Db): GitHubAccessDeps {
    return {
      runs: createRunsRepository(db, logger),
      intake: createIntakeRepository(db, createAuditLog(db, logger), logger),
      selections: createRepositorySelectionRepository(db, createAuditLog(db, logger), logger),
      registry: createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger),
      client: githubClient!,
      audit: createAuditLog(db, logger),
      logger,
    };
  }

  function buildCodingAgentService(db: Db): CodingAgentService {
    return createCodingAgentService({
      runs: createRunsRepository(db, logger),
      requirements: createRequirementsRepository(db, logger),
      repositoryContext: createRepositoryContextDeps(buildGitHubAccessDeps(db)),
      provider: codingAgentProvider,
      audit: createAuditLog(db, logger),
      logger,
    });
  }

  function buildChangeExecutionService(db: Db): ChangeExecutionService {
    return createChangeExecutionService({
      reviews: createChangeReviewRepository(db, createAuditLog(db, logger), logger),
      executions: createChangeExecutionRepository(db, createAuditLog(db, logger), logger),
      access: createGitHubAccessService(buildGitHubAccessDeps(db)),
      // Mock only — no real npm test/tsc/build execution exists anywhere in
      // this codebase yet; see docs/change-execution.md's "Current limitations".
      validation: createMockChangeValidationRunner(),
      audit: createAuditLog(db, logger),
      logger,
    });
  }

  function buildGithubPublishService(db: Db): GithubPublishService {
    return createGithubPublishService({
      reviews: createChangeReviewRepository(db, createAuditLog(db, logger), logger),
      executions: createChangeExecutionRepository(db, createAuditLog(db, logger), logger),
      selections: createRepositorySelectionRepository(db, createAuditLog(db, logger), logger),
      registry: createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger),
      client: githubClient!,
      publications: createGithubPublicationRepository(db, createAuditLog(db, logger), logger),
      audit: createAuditLog(db, logger),
      logger,
    });
  }

  // No real deployment mechanism exists anywhere in this repo (no
  // Dockerfile, no CI/CD workflow, no cloud-platform config, no deploy
  // script) — see docs/deployment.md's "Current limitations". Real
  // deployment therefore stays disabled (Section 21); only the mock
  // provider/validator are wired. Built once, not per db access: the mock
  // provider tracks deployed identifiers in memory across calls.
  const deploymentProvider = createMockDeploymentProvider();
  const postDeploymentValidator = createMockPostDeploymentValidator();

  function buildDeploymentService(db: Db): DeploymentService {
    return createDeploymentService({
      deployments: createDeploymentRepository(db, createAuditLog(db, logger), logger),
      provider: deploymentProvider,
      validator: postDeploymentValidator,
      audit: createAuditLog(db, logger),
      logger,
    });
  }

  // Non-null only outside production with NEUTARA_API_BASE_URL on a loopback
  // mock: the one condition under which test tickets may be created or deleted.
  const testTicketMockUrl = (() => {
    const n = loadNeutaraConfig(process.env);
    return config.nodeEnv !== 'production' && n.configured && n.config.mode === 'mock' ? n.config.baseUrl : null;
  })();

  const server = createHttpServer({
    logger,
    health: {
      version: VERSION,
      uptimeSeconds: () => process.uptime(),
      database: mongo,
    },
    ingest: {
      logger,
      webhookSecret,
      // Resolved per request: the connection manager reconnects in the
      // background, so a database that comes back makes /ingest work again
      // without a restart.
      get deliveries() {
        const db = mongo.db();
        return db ? createWebhookDeliveryRepository(db, logger) : undefined;
      },
      get audit() {
        const db = mongo.db();
        return db ? createAuditLog(db, logger) : undefined;
      },
    },
    approval: {
      logger,
      operatorToken,
      get intake() {
        const db = mongo.db();
        return db ? createIntakeRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    repositoryRegistry: {
      logger,
      operatorToken,
      get registry() {
        const db = mongo.db();
        return db ? createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    repositorySelection: {
      logger,
      operatorToken,
      get selections() {
        const db = mongo.db();
        return db ? createRepositorySelectionRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get registry() {
        const db = mongo.db();
        return db ? createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    // Test tickets can only be created against a loopback mock, and never in
    // production — see console-ui.ts's module comment. Deleting them is
    // mounted under exactly the same condition.
    // codingAgentEnabled: the Coding Agent route is mounted only with a GitHub
    // App client (see `codingAgent` below); the console says so instead of
    // offering a button that would 404.
    consoleUi: { ticketCreatorUrl: testTicketMockUrl, codingAgentEnabled: githubClient !== undefined },
    ...(testTicketMockUrl === null
      ? {}
      : {
          ticketDelete: {
            logger,
            operatorToken,
            get purger() {
              const db = mongo.db();
              return db ? createTestTicketPurger(db, createAuditLog(db, logger), logger) : undefined;
            },
          },
          registryDelete: {
            logger,
            operatorToken,
            get deleter() {
              const db = mongo.db();
              return db ? createTestRegistryDeleter(db, createAuditLog(db, logger), logger) : undefined;
            },
          },
        }),
    operatorTickets: {
      logger,
      operatorToken,
      get intake() {
        const db = mongo.db();
        return db ? createIntakeRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get requirements() {
        const db = mongo.db();
        return db ? createRequirementsRepository(db, logger) : undefined;
      },
      get runs() {
        const db = mongo.db();
        return db ? createRunsRepository(db, logger) : undefined;
      },
      get sources() {
        const db = mongo.db();
        if (!db) return undefined;
        return {
          selections: createRepositorySelectionRepository(db, createAuditLog(db, logger), logger),
          reviews: createChangeReviewRepository(db, createAuditLog(db, logger), logger),
          executions: createChangeExecutionRepository(db, createAuditLog(db, logger), logger),
          publications: createGithubPublicationRepository(db, createAuditLog(db, logger), logger),
          deployments: createDeploymentRepository(db, createAuditLog(db, logger), logger),
        };
      },
    },
    operatorQueue: {
      logger,
      operatorToken,
      get intake() {
        const db = mongo.db();
        return db ? createIntakeRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get requirements() {
        const db = mongo.db();
        return db ? createRequirementsRepository(db, logger) : undefined;
      },
      get selections() {
        const db = mongo.db();
        return db ? createSelectionQueueQueries(db) : undefined;
      },
      get registry() {
        const db = mongo.db();
        return db ? createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get reviews() {
        const db = mongo.db();
        return db ? createChangeReviewQueueQueries(db) : undefined;
      },
    },
    runStatus: {
      logger,
      operatorToken,
      get runs() {
        const db = mongo.db();
        return db ? createRunsRepository(db, logger) : undefined;
      },
      get selections() {
        const db = mongo.db();
        return db ? createRepositorySelectionRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get reviews() {
        const db = mongo.db();
        return db ? createChangeReviewRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get executions() {
        const db = mongo.db();
        return db ? createChangeExecutionRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get publications() {
        const db = mongo.db();
        return db ? createGithubPublicationRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get deployments() {
        const db = mongo.db();
        return db ? createDeploymentRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    changeReview: {
      logger,
      operatorToken,
      get reviews() {
        const db = mongo.db();
        return db ? createChangeReviewRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    deploymentStatus: {
      logger,
      operatorToken,
      get runs() {
        const db = mongo.db();
        return db ? createRunsRepository(db, logger) : undefined;
      },
      get reviews() {
        const db = mongo.db();
        return db ? createChangeReviewRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get executions() {
        const db = mongo.db();
        return db ? createChangeExecutionRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get publications() {
        const db = mongo.db();
        return db ? createGithubPublicationRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
      get deployments() {
        const db = mongo.db();
        return db ? createDeploymentRepository(db, createAuditLog(db, logger), logger) : undefined;
      },
    },
    // Requires a real GitHub App client — absent configuration means this
    // route is not mounted at all, the same choice /ingest makes for a
    // missing webhook secret's PRESENCE (here it is the route's EXISTENCE
    // that is conditional, since there is no credential to check per request).
    ...(githubClient === undefined
      ? {}
      : {
          codingAgent: {
            logger,
            operatorToken,
            get trigger() {
              const db = mongo.db();
              if (db === undefined) return undefined;
              return {
                codingAgent: buildCodingAgentService(db),
                reviews: createChangeReviewRepository(db, createAuditLog(db, logger), logger),
                selections: createRepositorySelectionRepository(db, createAuditLog(db, logger), logger),
                registry: createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger),
                client: githubClient,
              };
            },
          },
          // LLM-picked when OpenAI is configured (with a keyword fallback on any
          // failure), keyword-only otherwise — see coding-agent/file-suggestion.ts.
          suggestedFiles: {
            logger,
            operatorToken,
            suggester: openAiConfig.configured
              ? createOpenAiFileSuggester({ apiKey: openAiConfig.config.apiKey, model: openAiConfig.config.model, logger })
              : createHeuristicFileSuggester(),
            get sources() {
              const db = mongo.db();
              if (db === undefined) return undefined;
              return {
                runs: createRunsRepository(db, logger),
                intake: createIntakeRepository(db, createAuditLog(db, logger), logger),
                requirements: createRequirementsRepository(db, logger),
                githubAccess: createGitHubAccessService(buildGitHubAccessDeps(db)),
              };
            },
          },
        }),
  });

  // Phase 4: drain pending deliveries into intake items. Started only when
  // Neutara is configured — without it there is nothing to enrich with, and
  // a loop that can only fail is worse than no loop.
  //
  // `describeNeutaraStartup` reports which of the two switchable modes this
  // instance is running in (mock/loopback vs real), computed purely from
  // NEUTARA_API_BASE_URL — no application logic below this point branches
  // on mode at all; createNeutaraClient/enrichDelivery treat both
  // identically. See docs/neutara-integration-modes.md.
  let enrichment: EnrichmentLoop | undefined;
  const neutara = loadNeutaraConfig(process.env);
  const neutaraStartup = describeNeutaraStartup(neutara);
  if (!neutara.configured) {
    logger.warn(neutaraStartup.message);
  } else {
    logger.info(neutaraStartup.message, { mode: neutaraStartup.mode });
    const client = createNeutaraClient({
      baseUrl: neutara.config.baseUrl,
      token: neutara.config.token,
      logger,
    });
    enrichment = startEnrichmentLoop(
      {
        get deliveries() {
          return createWebhookDeliveryRepository(mongo.db()!, logger);
        },
        get intake() {
          const db = mongo.db()!;
          return createIntakeRepository(db, createAuditLog(db, logger), logger);
        },
        client,
        logger,
      },
      // Skipped while disconnected: a pass then could only produce errors.
      { isReady: () => mongo.db() !== undefined },
    );
  }

  // Queues a run for every approved intake item. Unlike enrichment, this has
  // no external dependency to gate on — only the database, already covered
  // by isReady — so it always starts, never conditionally.
  const orchestrator: OrchestratorLoop = startOrchestratorLoop(
    {
      get intake() {
        const db = mongo.db()!;
        return createIntakeRepository(db, createAuditLog(db, logger), logger);
      },
      get runs() {
        return createRunsRepository(mongo.db()!, logger);
      },
      get audit() {
        return createAuditLog(mongo.db()!, logger);
      },
      logger,
    },
    { isReady: () => mongo.db() !== undefined },
  );

  // Matches every queued run to a repositoryRegistry entry (or notes why it
  // could not). Like the orchestrator, this only depends on the database, so
  // it always starts, never conditionally.
  const repositorySelection: RepositorySelectionLoop = startRepositorySelectionLoop(
    {
      get intake() {
        const db = mongo.db()!;
        return createIntakeRepository(db, createAuditLog(db, logger), logger);
      },
      get runs() {
        return createRunsRepository(mongo.db()!, logger);
      },
      get registry() {
        const db = mongo.db()!;
        return createRepositoryRegistryRepository(db, createAuditLog(db, logger), logger);
      },
      get selections() {
        const db = mongo.db()!;
        return createRepositorySelectionRepository(db, createAuditLog(db, logger), logger);
      },
      get audit() {
        return createAuditLog(mongo.db()!, logger);
      },
      logger,
    },
    { isReady: () => mongo.db() !== undefined },
  );

  // Runs the Requirements Agent for every received intake item and advances
  // it to pending_approval — see requirements/queue.ts. Only depends on the
  // database (the LLM analyzer is optional, falling back to the
  // deterministic stub), so it always starts, never conditionally.
  const requirements: RequirementsLoop = startRequirementsLoop(
    {
      get intake() {
        const db = mongo.db()!;
        return createIntakeRepository(db, createAuditLog(db, logger), logger);
      },
      get repository() {
        return createRequirementsRepository(mongo.db()!, logger);
      },
      get audit() {
        return createAuditLog(mongo.db()!, logger);
      },
      logger,
      // agentVersion travels with analyze, the same pairing
      // scripts/run-requirements-agent.ts uses — without it every LLM
      // analysis would be recorded under the stub's version.
      ...(requirementsAnalyze === undefined || !openAiConfig.configured
        ? {}
        : { analyze: requirementsAnalyze, agentVersion: `openai-${openAiConfig.config.model}` }),
    },
    { isReady: () => mongo.db() !== undefined },
  );

  // Drives approved reviews through execution and successful executions
  // through publishing — see pipeline/scheduler.ts. Requires a real GitHub
  // App client; without one, neither stage can reach GitHub at all, so the
  // loop is not started (the same "disabled, not fatal" choice enrichment
  // makes for a missing Neutara config).
  let pipeline: PipelineLoop | undefined;
  if (githubClient === undefined) {
    logger.warn('pipeline loop disabled: no GitHub App client configured');
  } else {
    pipeline = startPipelineLoop(
      {
        changeExecution: {
          get reviews() {
            return createChangeReviewRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get executions() {
            return createChangeExecutionRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get executionService() {
            return buildChangeExecutionService(mongo.db()!);
          },
          logger,
        },
        githubPublish: {
          get executions() {
            return createChangeExecutionRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get publications() {
            return createGithubPublicationRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get publishService() {
            return buildGithubPublishService(mongo.db()!);
          },
          logger,
        },
        prMergeDetection: {
          get publications() {
            return createGithubPublicationRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get deployments() {
            return createDeploymentRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get selections() {
            return createRepositorySelectionRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get registry() {
            return createRepositoryRegistryRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          client: githubClient,
          get audit() {
            return createAuditLog(mongo.db()!, logger);
          },
          logger,
        },
        deployment: {
          get deployments() {
            return createDeploymentRepository(mongo.db()!, createAuditLog(mongo.db()!, logger), logger);
          },
          get deploymentService() {
            return buildDeploymentService(mongo.db()!);
          },
          logger,
        },
        logger,
      },
      { isReady: () => mongo.db() !== undefined },
    );
  }

  server.listen(config.port, () => {
    logger.info('http server listening', { port: config.port });
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    // Stopped before the connection closes, so an in-flight pass is not left
    // reaching for a client that is going away.
    enrichment?.stop();
    orchestrator.stop();
    repositorySelection.stop();
    requirements.stop();
    pipeline?.stop();
    server.close(() => {
      void (async () => {
        await mongo.close();
        process.exit(0);
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

await main();
