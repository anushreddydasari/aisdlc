/**
 * Runs the Requirements Agent once against a single intake item, for
 * manual/local testing.
 *
 *   npm run requirements:run -- CF-33261
 *
 * Connects with the same credential and database-target resolution as the
 * service itself (see resolveRuntimeMongoUri / resolveDatabaseName in
 * src/config/env.ts): outside production this requires AISDLC_TEST_MONGODB_URI
 * and AISDLC_DATABASE_NAME, and refuses to run if the test URI would
 * authenticate as the production identity. Like every other local-testing
 * script in this repo, it refuses to run against the production database.
 *
 * Reads the intake item through IntakeRepository.findByIssueKey(). The only
 * write this script makes to it is the state transition
 * received -> pending_approval, once analysis freshly completes (see
 * requirements/approval-transition.ts) — the original ticket content
 * (snapshot, sourceHash) is never touched, so the item's identity and
 * history stay intact; only its approval-gate status moves forward. It
 * never contacts Neutara or any other external API besides (optionally)
 * OpenAI.
 *
 * Analyzer selection mirrors loadNeutaraConfig's "absent is a valid state"
 * pattern: with OPENAI_API_KEY set, this uses the real LLM-backed analyzer
 * (src/requirements/openai-analyzer.ts); without it, the deterministic stub
 * (src/requirements/analyzer.ts) runs instead, same as before this option
 * existed. Nothing about validation, persistence, retry or duplicate
 * handling changes either way — both are just RequirementsAgentDeps.analyze.
 */

import {
  loadOpenAiConfig,
  loadConfig,
  resolveDatabaseName,
  resolveRuntimeMongoUri,
  ConfigError,
} from '../config/env.ts';
import { DATABASE_NAME, connect } from '../db/client.ts';
import { createAuditLog } from '../db/audit-log.ts';
import { createIntakeRepository } from '../intake/repository.ts';
import { createRequirementsRepository } from '../requirements/repository.ts';
import { createLlmRequirementsAnalyzer } from '../requirements/openai-analyzer.ts';
import { shouldRecordUsage, type AnalysisUsage } from '../requirements/repository.ts';
import { runRequirementsAgent, type RequirementsAgentDeps } from '../requirements/worker.ts';
import { advanceToPendingApproval } from '../requirements/approval-transition.ts';
import { createLogger } from '../logging/logger.ts';

const logger = createLogger({ level: 'debug', base: { task: 'requirements:run' } });

const issueKey = process.argv[2];
if (issueKey === undefined || issueKey.trim() === '') {
  logger.error('usage: npm run requirements:run -- <issueKey>');
  process.exit(64); // EX_USAGE
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error('invalid configuration', { detail: error.message });
    process.exit(78); // EX_CONFIG
  }
  throw error;
}

const target = resolveDatabaseName(process.env, config.nodeEnv, DATABASE_NAME);
if (!target.ok) {
  logger.error('unsafe database target', { detail: target.reason });
  process.exit(78); // EX_CONFIG
}

const credential = resolveRuntimeMongoUri(process.env, config.nodeEnv, config.mongodbUri);
if (!credential.ok) {
  logger.error('unsafe mongodb credential', { detail: credential.reason });
  process.exit(78); // EX_CONFIG
}

const mongo = await connect({
  uri: credential.uri,
  logger,
  databaseName: target.databaseName,
  appName: 'aisdlc-requirements-run',
});

const openai = loadOpenAiConfig(process.env);
// Captured via the callback, then attached to the stored row separately
// (RequirementsRepository.recordUsage) after a successful run — usage has
// nothing to do with the analysis result itself, so it never touches
// RequirementsResult or worker.ts.
let capturedUsage: AnalysisUsage | undefined;
const analyzerOverride: Pick<RequirementsAgentDeps, 'analyze' | 'agentVersion'> = openai.configured
  ? {
      analyze: createLlmRequirementsAnalyzer({
        apiKey: openai.config.apiKey,
        model: openai.config.model,
        logger,
        onUsage: (usage) => {
          capturedUsage = usage;
        },
      }),
      agentVersion: `openai-${openai.config.model}`,
    }
  : {};
if (openai.configured) {
  logger.info('using the LLM-backed requirements analyzer', { model: openai.config.model });
} else {
  logger.warn(openai.reason);
}

try {
  const audit = createAuditLog(mongo.db, logger);
  const intake = createIntakeRepository(mongo.db, audit, logger);
  const requirements = createRequirementsRepository(mongo.db, logger);

  const item = await intake.findByIssueKey(issueKey);
  if (item === null) {
    logger.error('no intake item found for issueKey', { issueKey });
    process.exitCode = 1;
  } else {
    const outcome = await runRequirementsAgent(item, {
      repository: requirements,
      audit,
      logger,
      ...analyzerOverride,
    });
    logger.info('requirements agent finished', { issueKey, outcome: outcome.outcome });

    // Only when this run actually called the LLM and produced a fresh
    // completed result — not on skipped_up_to_date (no call was made) and
    // not on a failure (nothing to attribute usage to). See
    // shouldRecordUsage in repository.ts for the exact rule and why.
    let finalDocument = outcome.document;
    if (shouldRecordUsage(outcome.outcome, capturedUsage)) {
      finalDocument = await requirements.recordUsage(item._id!, capturedUsage);
    }

    const advance = await advanceToPendingApproval(item, outcome.outcome, { intake, logger });
    logger.info('approval-gate advance decision', { issueKey, advance });

    console.log(JSON.stringify(finalDocument, null, 2));
  }
} catch (error) {
  // Mirrors the /ingest pattern in src/api/ingest.ts's record(): log the
  // complete structured error rather than letting it surface as an uncaught
  // exception and a raw stack trace. runRequirementsAgent() itself stays
  // throw-on-failure — this is the entrypoint's job, not the domain worker's,
  // the same split enrichDelivery/drainPending already draw in
  // src/enrichment/worker.ts.
  logger.error('requirements agent run failed', { issueKey, error });
  process.exitCode = 1;
} finally {
  await mongo.close();
}
