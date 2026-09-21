/**
 * Stub Requirements Agent.
 *
 * Deterministic and rule-based: the same snapshot always produces the same
 * result, with no LLM call, no network access and no randomness or clock
 * read. That is the whole point of this version — it exercises the
 * validate -> analyze -> store pipeline end to end so a real, LLM-backed
 * analyzer can be swapped in later (via RequirementsAgentDeps.analyze in
 * worker.ts) without touching the storage or retry logic around it.
 *
 * Callers must run validateSnapshotForRequirements() first; this function
 * assumes title, description and issueType are already non-empty.
 */

import type { IntakeSnapshot } from '../intake/repository.ts';

/** Bumped whenever the analysis logic changes, so a stored result names its origin. */
export const STUB_ANALYZER_VERSION = 'stub-v1';

export interface RequirementsResult {
  readonly summary: string;
  readonly problemStatement: string;
  readonly functionalRequirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly suggestedArea: string | null;
}

/** Max functional requirements pulled out of the description, to keep the result bounded. */
const MAX_FUNCTIONAL_REQUIREMENTS = 5;

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text: string): string[] {
  if (text === '') return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function deriveFunctionalRequirements(snapshot: IntakeSnapshot, plainDescription: string): string[] {
  const sentences = splitSentences(plainDescription).slice(0, MAX_FUNCTIONAL_REQUIREMENTS);
  if (sentences.length > 0) {
    return sentences.map((sentence) => `The system shall address: ${sentence}`);
  }
  // No sentence-shaped content (e.g. a one-word description); fall back to
  // something still traceable to the ticket rather than an empty list.
  return [`The system shall resolve the ${snapshot.issueType} described in '${snapshot.title}'.`];
}

function deriveAcceptanceCriteria(
  snapshot: IntakeSnapshot,
  functionalRequirements: readonly string[],
): string[] {
  return functionalRequirements.map(
    (requirement, index) =>
      `Given ${snapshot.issueType} '${snapshot.title}', when requirement ${index + 1} is implemented, ` +
      `then the following is satisfied: ${requirement}`,
  );
}

function deriveRisks(snapshot: IntakeSnapshot, plainDescription: string): string[] {
  const risks: string[] = [];

  if ((snapshot.labels ?? []).length === 0) {
    risks.push('No labels are set on the ticket; the affected area may be broader than described.');
  }
  if (snapshot.parentKey === null || snapshot.parentKey === undefined) {
    risks.push('No parent ticket is linked; related work or dependencies may be undocumented.');
  }
  if (plainDescription.length < 40) {
    risks.push('The description is very short; the requirements above may be incomplete.');
  }
  if (risks.length === 0) {
    risks.push('No open questions identified from the available ticket data.');
  }

  return risks;
}

export function analyzeRequirements(snapshot: IntakeSnapshot): RequirementsResult {
  const plainDescription = stripHtml(snapshot.description);
  const functionalRequirements = deriveFunctionalRequirements(snapshot, plainDescription);

  return {
    summary: snapshot.title.trim(),
    problemStatement:
      plainDescription !== '' ? plainDescription : `No description was provided for '${snapshot.title}'.`,
    functionalRequirements,
    acceptanceCriteria: deriveAcceptanceCriteria(snapshot, functionalRequirements),
    assumptions: [
      'The ticket description reflects the complete scope of the request.',
      'No stakeholder input is required beyond what is recorded on the ticket.',
    ],
    risks: deriveRisks(snapshot, plainDescription),
    suggestedArea: snapshot.project ?? snapshot.labels?.[0] ?? null,
  };
}
