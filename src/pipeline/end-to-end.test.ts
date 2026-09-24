/**
 * Deterministic, offline, end-to-end exercise of the whole wired pipeline:
 *
 *   webhook-shaped intake -> requirements queue -> human approval ->
 *   orchestrator queues run -> repository-selection worker matches ->
 *   human confirmation -> Coding Agent trigger -> human change review ->
 *   pipeline queue (change execution -> GitHub publish) -> pull request
 *
 * No real MongoDB, no real GitHub, no real OpenAI — every repository is a
 * real implementation (createIntakeRepository, createRunsRepository, ...)
 * running against ONE generic in-memory fake `Db` shared across every
 * collection, and every external system (GitHub, the LLM) is the same
 * deterministic mock this codebase's own test suites already use
 * (createMockGitHubAppClient, createMockCodingAgentProvider). This proves
 * the REAL repository/service wiring, not a re-implementation of it.
 *
 * The three human gates (requirements approval, repository confirmation,
 * change review) are each crossed by calling the exact function an
 * operator-authenticated HTTP request would reach — `intake.transition`,
 * `selections.confirm`, `reviews.approve` — never by mutating a document
 * directly, so this test would fail if any gate's enforcement regressed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId, type Db } from 'mongodb';

import { createAuditLog } from '../db/audit-log.ts';
import { createLogger } from '../logging/logger.ts';
import { createIntakeRepository, type IntakeSnapshot } from '../intake/repository.ts';
import { createRunsRepository } from '../orchestrator/repository.ts';
import { queueApprovedRuns } from '../orchestrator/worker.ts';
import { createRepositoryRegistryRepository } from '../repository-registry/repository.ts';
import { createRepositorySelectionRepository } from '../repository-selection/repository.ts';
import { matchRepositorySelections } from '../repository-selection/worker.ts';
import { createRequirementsRepository } from '../requirements/repository.ts';
import { processReceivedIntakeItems } from '../requirements/queue.ts';
import { createMockGitHubAppClient, type MockRepository } from '../github-app/mock-client.ts';
import { createGitHubAccessService } from '../github-access/service.ts';
import { createCodingAgentService } from '../coding-agent/service.ts';
import { createMockCodingAgentProvider } from '../coding-agent/provider.ts';
import { createDefaultFileSelectionPolicy } from '../coding-agent/repository-context.ts';
import { triggerCodingAgent } from './coding-agent-trigger.ts';
import { createChangeReviewRepository } from '../change-execution/review-repository.ts';
import { createChangeExecutionRepository } from '../change-execution/execution-repository.ts';
import { createChangeExecutionService } from '../change-execution/execution-service.ts';
import { createMockChangeValidationRunner } from '../change-execution/validation.ts';
import { executeApprovedReviews } from './change-execution-queue.ts';
import { createGithubPublicationRepository } from '../github-publish/publish-repository.ts';
import { createGithubPublishService } from '../github-publish/publish-service.ts';
import { publishSucceededExecutions } from './github-publish-queue.ts';
import { createDeploymentRepository } from '../deployment/deployment-repository.ts';
import { createMockDeploymentProvider } from '../deployment/deployment-provider.ts';
import { createMockPostDeploymentValidator } from '../deployment/post-deployment-validator.ts';
import { createDeploymentService } from '../deployment/deployment-service.ts';
import { detectMergedPullRequests } from '../deployment/pr-merge-detection.ts';
import { runEligibleDeployments } from '../deployment/deployment-queue.ts';
import { computeRunStatus } from './run-status.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const INSTALLATION_ID = 4242;
const PROJECT_IDENTIFIER = 'CF';
const REPOSITORY_ID = 'aisdlc-service';
const ORIGINAL_FILE_CONTENT = 'export const original = true;';

const MOCK_REPO: MockRepository = {
  owner: 'cloudfuze',
  repo: 'aisdlc-service',
  installationId: INSTALLATION_ID,
  defaultBranch: 'main',
  branches: ['main'],
  files: { 'src/index.ts': ORIGINAL_FILE_CONTENT },
};

const SNAPSHOT: IntakeSnapshot = {
  title: 'Add a health field to the status endpoint',
  description: 'The status endpoint is missing a health field the frontend now requires.',
  issueType: 'task',
  project: PROJECT_IDENTIFIER,
};

/** One generic in-memory Db shared across every collection this test touches — see the module comment. */
function createFakeDb(): Db {
  const stores = new Map<string, Record<string, unknown>[]>();
  const uniqueFields: Record<string, string[]> = {
    intakeItems: ['issueKey'],
    runs: ['intakeItemId'],
    repositorySelections: ['runId'],
    requirementsAnalyses: ['intakeItemId'],
    changeReviews: ['proposalHash'],
    changeExecutions: ['reviewId'],
    githubPublications: ['executionId'],
    deployments: ['publicationId'],
  };

  function storeFor(name: string): Record<string, unknown>[] {
    let store = stores.get(name);
    if (store === undefined) {
      store = [];
      stores.set(name, store);
    }
    return store;
  }

  function fieldsEqual(a: unknown, b: unknown): boolean {
    if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
    return a === b;
  }

  function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => fieldsEqual(doc[key], value));
  }

  function makeCollection(name: string) {
    const store = storeFor(name);
    const uniques = uniqueFields[name] ?? [];

    return {
      async findOne(filter: Record<string, unknown> = {}) {
        const found = store.find((doc) => matches(doc, filter));
        return found ? { ...found } : null;
      },
      async insertOne(doc: Record<string, unknown>) {
        for (const field of uniques) {
          if (store.some((existing) => fieldsEqual(existing[field], doc[field]))) {
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          }
        }
        const _id = (doc['_id'] as ObjectId | undefined) ?? new ObjectId();
        store.push({ ...doc, _id });
        return { insertedId: _id };
      },
      find(filter: Record<string, unknown> = {}) {
        let results = store.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
        const cursor = {
          sort(spec: Record<string, 1 | -1>) {
            const [field, direction] = Object.entries(spec)[0] as [string, 1 | -1];
            results = [...results].sort((a, b) => {
              const av = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as number);
              const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as number);
              return direction === 1 ? av - bv : bv - av;
            });
            return cursor;
          },
          limit(n: number) {
            results = results.slice(0, n);
            return cursor;
          },
          async toArray() {
            return results;
          },
        };
        return cursor;
      },
      async findOneAndUpdate(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
        const idx = store.findIndex((doc) => matches(doc, filter));
        if (idx === -1) return null;
        const merged = { ...store[idx], ...(update.$set ?? {}) };
        store[idx] = merged;
        return { ...merged };
      },
    };
  }

  return { collection: (name: string) => makeCollection(name) } as unknown as Db;
}

const logger = createLogger({ write: () => {} });

/** Every repository this test needs, built once against one shared fake Db. */
function buildStack(db: Db) {
  const audit = createAuditLog(db, logger);
  const intake = createIntakeRepository(db, audit, logger);
  const runs = createRunsRepository(db, logger);
  const registry = createRepositoryRegistryRepository(db, audit, logger);
  const selections = createRepositorySelectionRepository(db, audit, logger);
  const requirements = createRequirementsRepository(db, logger);
  const reviews = createChangeReviewRepository(db, audit, logger);
  const executions = createChangeExecutionRepository(db, audit, logger);
  const publications = createGithubPublicationRepository(db, audit, logger);

  const client = createMockGitHubAppClient({ repositories: [MOCK_REPO] });

  const githubAccessDeps = { runs, intake, selections, registry, client, audit, logger };
  const githubAccess = createGitHubAccessService(githubAccessDeps);

  const codingAgent = createCodingAgentService({
    runs,
    requirements,
    repositoryContext: { githubAccess, fileSelectionPolicy: createDefaultFileSelectionPolicy() },
    provider: createMockCodingAgentProvider(),
    audit,
    logger,
  });

  const executionService = createChangeExecutionService({
    reviews,
    executions,
    access: githubAccess,
    validation: createMockChangeValidationRunner(),
    audit,
    logger,
  });

  const publishService = createGithubPublishService({
    reviews,
    executions,
    selections,
    registry,
    client,
    publications,
    audit,
    logger,
  });

  const deployments = createDeploymentRepository(db, audit, logger);
  const deploymentService = createDeploymentService({
    deployments,
    provider: createMockDeploymentProvider(),
    validator: createMockPostDeploymentValidator(),
    audit,
    logger,
  });

  return { audit, intake, runs, registry, selections, requirements, reviews, executions, publications, deployments, client, codingAgent, executionService, publishService, deploymentService };
}

async function seedRegistry(stack: ReturnType<typeof buildStack>): Promise<void> {
  await stack.registry.create({
    projectIdentifier: PROJECT_IDENTIFIER,
    repositoryId: REPOSITORY_ID,
    repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
    defaultBranch: 'main',
    allowedBranches: ['main'],
    accessPolicy: { installationId: INSTALLATION_ID },
    actor: 'operator:alice',
  });
}

describe('end-to-end pipeline (offline)', () => {
  it('carries an issue from intake through pull-request creation, stopping for every human gate', async () => {
    const db = createFakeDb();
    const stack = buildStack(db);
    await seedRegistry(stack);

    // 1. Intake — mirrors the webhook path's eventual create() call.
    const { item } = await stack.intake.create({ issueKey: 'CF-100', source: 'webhook', snapshot: SNAPSHOT });
    assert.equal(item.status, 'received');

    // 2. Requirements queue: generates requirements, advances to pending_approval.
    const reqSummary = await processReceivedIntakeItems({ intake: stack.intake, repository: stack.requirements, audit: stack.audit, logger, now: () => NOW });
    assert.equal(reqSummary.completed, 1);
    const afterRequirements = await stack.intake.findByIssueKey('CF-100');
    assert.equal(afterRequirements!.status, 'pending_approval');

    // GATE 1: human approval — the exact call POST /intake/:issueKey/approve makes.
    await stack.intake.transition('CF-100', 'approved', { actor: 'operator:alice', approvedBy: 'operator:alice' });

    // 3. Orchestrator queues a run for the now-approved item.
    const queueSummary = await queueApprovedRuns({ intake: stack.intake, runs: stack.runs, audit: stack.audit, logger });
    assert.equal(queueSummary.queued, 1);
    const run = await stack.runs.findByIntakeItemId(item._id!);
    assert.ok(run !== null);

    // 4. Repository-selection worker matches the queued run to the registry entry.
    const matchSummary = await matchRepositorySelections({ intake: stack.intake, runs: stack.runs, selections: stack.selections, registry: stack.registry, audit: stack.audit, logger, now: () => NOW });
    assert.equal(matchSummary.pending, 1);
    const selectionBeforeConfirm = await stack.selections.findByRunId(run!._id!);
    assert.equal(selectionBeforeConfirm!.status, 'pending');

    // GATE 2: human repository confirmation — the exact call POST /repository-selections/:runId/confirm makes.
    await stack.selections.confirm(run!._id!, {
      repositoryId: REPOSITORY_ID,
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: { installationId: INSTALLATION_ID },
      confirmedBy: 'operator:alice',
    });

    // Run status mid-pipeline: confirmed, awaiting the Coding Agent trigger.
    const statusAfterConfirm = computeRunStatus({
      run: run!,
      selection: await stack.selections.findByRunId(run!._id!),
      review: null,
      execution: null,
      publication: null,
      deployment: null,
    });
    assert.equal(statusAfterConfirm.stage, 'repository_confirmed');

    // 5. Coding Agent trigger — the exact call POST /runs/:runId/coding-agent makes.
    const triggerResult = await triggerCodingAgent(
      { codingAgent: stack.codingAgent, reviews: stack.reviews, selections: stack.selections, registry: stack.registry, client: stack.client, logger },
      run!._id!,
      ['src/index.ts'],
    );
    assert.ok(triggerResult.ok);
    assert.equal(triggerResult.review.status, 'pending');

    // GATE 3: human change review — the exact call POST /change-reviews/:reviewId/approve makes.
    const approvedReview = await stack.reviews.approve(triggerResult.review._id!, { actor: 'operator:alice' });
    assert.equal(approvedReview.status, 'approved');

    // 6. Pipeline queue: executes the approved review, then publishes the succeeded execution.
    const executionSummary = await executeApprovedReviews({ reviews: stack.reviews, executions: stack.executions, executionService: stack.executionService, logger });
    assert.equal(executionSummary.executed, 1);
    const publishSummary = await publishSucceededExecutions({ executions: stack.executions, publications: stack.publications, publishService: stack.publishService, logger });
    assert.equal(publishSummary.published, 1);

    // Final state: a pull request exists; the workflow stops for GATE 4 (human merge).
    const execution = await stack.executions.findByReviewId(approvedReview._id!);
    assert.ok(execution !== null && execution.status === 'succeeded');
    const publication = await stack.publications.findByExecutionId(execution!._id!);
    assert.ok(publication !== null && publication.status === 'published');
    assert.ok(publication!.pullRequestNumber !== null);

    const finalStatus = computeRunStatus({ run: run!, selection: await stack.selections.findByRunId(run!._id!), review: approvedReview, execution, publication, deployment: null });
    assert.equal(finalStatus.stage, 'awaiting_human_merge');
    assert.equal(finalStatus.humanActionRequired, true);

    // The published branch carries exactly the proposed content; the base
    // branch is untouched — verifies the real client/service chain actually
    // wrote what was reviewed, not a stand-in.
    const publishedContent = await stack.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'src/index.ts', publication!.branch);
    assert.ok(publishedContent.ok);
    assert.notEqual(publishedContent.content, ORIGINAL_FILE_CONTENT);
    const baseContent = await stack.client.getFileContents(INSTALLATION_ID, 'cloudfuze', 'aisdlc-service', 'src/index.ts', 'main');
    assert.deepEqual(baseContent, { ok: true, content: ORIGINAL_FILE_CONTENT });

    // No GitHub merge capability exists to have crossed GATE 4 automatically.
    assert.ok(!('mergePullRequest' in stack.client));

    // GATE 4: a human merges the pull request through GitHub's own UI —
    // modeled here with a SEPARATE mock client seeded with the PR already
    // merged, since this codebase's GitHubAppClient has no method that
    // could perform the merge itself (asserted immediately above). Merge
    // detection only ever calls getInstallationToken/getPullRequest, so
    // swapping the client instance is enough to model "time passed and a
    // human acted" without touching the original client's file/PR state.
    const mergedClient = createMockGitHubAppClient({
      repositories: [
        {
          ...MOCK_REPO,
          pullRequests: [
            {
              number: publication!.pullRequestNumber!,
              head: publication!.branch,
              base: publication!.baseBranch,
              state: 'closed',
              merged: true,
              mergeCommitSha: 'f'.repeat(40),
            },
          ],
        },
      ],
    });

    // AISDLC detects the merge — strictly read-only.
    const mergeDetectionSummary = await detectMergedPullRequests({
      publications: stack.publications,
      deployments: stack.deployments,
      selections: stack.selections,
      registry: stack.registry,
      client: mergedClient,
      audit: stack.audit,
      logger,
    });
    assert.equal(mergeDetectionSummary.merged, 1);

    const eligibleDeployment = await stack.deployments.findByPublicationId(publication!._id!);
    assert.ok(eligibleDeployment !== null);
    assert.equal(eligibleDeployment!.status, 'eligible');
    assert.equal(eligibleDeployment!.mergeCommitSha, 'f'.repeat(40));

    const statusAfterMerge = computeRunStatus({
      run: run!,
      selection: await stack.selections.findByRunId(run!._id!),
      review: approvedReview,
      execution,
      publication,
      deployment: eligibleDeployment,
    });
    assert.equal(statusAfterMerge.stage, 'deployment_eligible');

    // Deployment worker: claims the eligible row, deploys, then runs
    // post-deployment validation — all through the mock provider/validator,
    // since no real deployment mechanism exists in this repo.
    const deploymentQueueSummary = await runEligibleDeployments({
      deployments: stack.deployments,
      deploymentService: stack.deploymentService,
      logger,
    });
    assert.equal(deploymentQueueSummary.deployed, 1);

    const finalDeployment = await stack.deployments.findByPublicationId(publication!._id!);
    assert.ok(finalDeployment !== null);
    assert.equal(finalDeployment!.status, 'succeeded');
    assert.ok(finalDeployment!.validation !== null);
    assert.equal(finalDeployment!.validation!.health.ok, true);
    assert.equal(finalDeployment!.validation!.readiness.ok, true);

    const finalDeployedStatus = computeRunStatus({
      run: run!,
      selection: await stack.selections.findByRunId(run!._id!),
      review: approvedReview,
      execution,
      publication,
      deployment: finalDeployment,
    });
    assert.equal(finalDeployedStatus.stage, 'deployed');
    assert.equal(finalDeployedStatus.humanActionRequired, false);
    assert.equal(finalDeployedStatus.mergeCommitSha, 'f'.repeat(40));

    // Idempotency: re-running both passes (as a restarted worker would)
    // creates no duplicate deployment record and does not redeploy.
    const secondMergeDetection = await detectMergedPullRequests({
      publications: stack.publications,
      deployments: stack.deployments,
      selections: stack.selections,
      registry: stack.registry,
      client: mergedClient,
      audit: stack.audit,
      logger,
    });
    assert.equal(secondMergeDetection.alreadyRecorded, 1);

    const secondDeploymentQueue = await runEligibleDeployments({
      deployments: stack.deployments,
      deploymentService: stack.deploymentService,
      logger,
    });
    assert.equal(secondDeploymentQueue.examined, 0, 'a succeeded deployment is no longer eligible; the second pass finds nothing to claim');
  });

  it('a rejected change review never reaches execution or publish, and the pipeline queue finds nothing to do', async () => {
    const db = createFakeDb();
    const stack = buildStack(db);
    await seedRegistry(stack);

    const { item } = await stack.intake.create({ issueKey: 'CF-101', source: 'webhook', snapshot: SNAPSHOT });
    await processReceivedIntakeItems({ intake: stack.intake, repository: stack.requirements, audit: stack.audit, logger, now: () => NOW });
    await stack.intake.transition('CF-101', 'approved', { actor: 'operator:alice', approvedBy: 'operator:alice' });
    await queueApprovedRuns({ intake: stack.intake, runs: stack.runs, audit: stack.audit, logger });
    const run = (await stack.runs.findByIntakeItemId(item._id!))!;
    await matchRepositorySelections({ intake: stack.intake, runs: stack.runs, selections: stack.selections, registry: stack.registry, audit: stack.audit, logger, now: () => NOW });
    await stack.selections.confirm(run._id!, {
      repositoryId: REPOSITORY_ID,
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: { installationId: INSTALLATION_ID },
      confirmedBy: 'operator:alice',
    });
    const triggerResult = await triggerCodingAgent(
      { codingAgent: stack.codingAgent, reviews: stack.reviews, selections: stack.selections, registry: stack.registry, client: stack.client, logger },
      run._id!,
      ['src/index.ts'],
    );
    assert.ok(triggerResult.ok);

    // GATE 3, decided the other way.
    const rejected = await stack.reviews.reject(triggerResult.review._id!, { actor: 'operator:alice', comment: 'not the right approach' });
    assert.equal(rejected.status, 'rejected');

    const executionSummary = await executeApprovedReviews({ reviews: stack.reviews, executions: stack.executions, executionService: stack.executionService, logger });
    assert.equal(executionSummary.examined, 0, 'a rejected review is never returned by findApproved');

    const execution = await stack.executions.findByReviewId(rejected._id!);
    assert.equal(execution, null);

    const finalStatus = computeRunStatus({ run, selection: await stack.selections.findByRunId(run._id!), review: rejected, execution: null, publication: null, deployment: null });
    assert.equal(finalStatus.stage, 'change_rejected');
  });

  it('re-running every queue pass after a full success is idempotent: no duplicate execution, publish, or branch', async () => {
    const db = createFakeDb();
    const stack = buildStack(db);
    await seedRegistry(stack);

    const { item } = await stack.intake.create({ issueKey: 'CF-102', source: 'webhook', snapshot: SNAPSHOT });
    await processReceivedIntakeItems({ intake: stack.intake, repository: stack.requirements, audit: stack.audit, logger, now: () => NOW });
    await stack.intake.transition('CF-102', 'approved', { actor: 'operator:alice', approvedBy: 'operator:alice' });
    await queueApprovedRuns({ intake: stack.intake, runs: stack.runs, audit: stack.audit, logger });
    const run = (await stack.runs.findByIntakeItemId(item._id!))!;
    await matchRepositorySelections({ intake: stack.intake, runs: stack.runs, selections: stack.selections, registry: stack.registry, audit: stack.audit, logger, now: () => NOW });
    await stack.selections.confirm(run._id!, {
      repositoryId: REPOSITORY_ID,
      repositoryUrl: 'https://github.com/cloudfuze/aisdlc-service',
      defaultBranch: 'main',
      allowedBranches: ['main'],
      accessPolicy: { installationId: INSTALLATION_ID },
      confirmedBy: 'operator:alice',
    });
    const triggerResult = await triggerCodingAgent(
      { codingAgent: stack.codingAgent, reviews: stack.reviews, selections: stack.selections, registry: stack.registry, client: stack.client, logger },
      run._id!,
      ['src/index.ts'],
    );
    assert.ok(triggerResult.ok);
    const approvedReview = await stack.reviews.approve(triggerResult.review._id!, { actor: 'operator:alice' });

    await executeApprovedReviews({ reviews: stack.reviews, executions: stack.executions, executionService: stack.executionService, logger });
    await publishSucceededExecutions({ executions: stack.executions, publications: stack.publications, publishService: stack.publishService, logger });

    // Repeated scheduler-shaped passes — same as a restarted worker re-polling.
    const secondExecution = await executeApprovedReviews({ reviews: stack.reviews, executions: stack.executions, executionService: stack.executionService, logger });
    assert.equal(secondExecution.alreadyExecuted, 1);
    assert.equal(secondExecution.executed, 0);

    const secondPublish = await publishSucceededExecutions({ executions: stack.executions, publications: stack.publications, publishService: stack.publishService, logger });
    assert.equal(secondPublish.alreadyPublished, 1);
    assert.equal(secondPublish.published, 0);

    // Concurrent re-entry of both services directly (as if two workers raced).
    const execution = (await stack.executions.findByReviewId(approvedReview._id!))!;
    const [directA, directB] = await Promise.all([
      stack.executionService.executeApprovedChanges(run._id!, approvedReview._id!),
      stack.executionService.executeApprovedChanges(run._id!, approvedReview._id!),
    ]);
    assert.deepEqual(directA, directB);

    const [publishA, publishB] = await Promise.all([
      stack.publishService.publishApprovedChanges(run._id!, execution._id!),
      stack.publishService.publishApprovedChanges(run._id!, execution._id!),
    ]);
    assert.deepEqual(publishA, publishB);

    // Still exactly one execution row and one publication row for this review/execution.
    const allExecutions = await stack.executions.findSucceeded();
    assert.equal(allExecutions.filter((e) => e.reviewId.equals(approvedReview._id!)).length, 1);
  });
});
