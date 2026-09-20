/**
 * Health endpoints.
 *
 * Two of them, because they answer different questions:
 *   GET /health       liveness  — is the process up? never touches the database
 *   GET /health/ready readiness — can it serve? reflects live connection state
 *
 * Readiness never throws and never blocks: the connection manager's state is
 * re-read on every probe, so an instance that lost its database recovers on
 * its own once the database returns.
 */

import type { ConnectionState } from '../db/client.ts';

export type HealthStatus = 'ok' | 'degraded';

export type DependencyStatus =
  /** Reachable. */
  | 'ok'
  /** Configured, not yet connected — still retrying. */
  | 'connecting'
  /** Configured and connected, but the ping failed or the manager stopped. */
  | 'unavailable'
  /** No database was wired up at all. */
  | 'not_configured';

export interface HealthResponse {
  readonly status: HealthStatus;
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}

export interface ReadinessResponse extends HealthResponse {
  readonly dependencies: {
    readonly database: DependencyStatus;
  };
}

export const SERVICE_NAME = 'aisdlc-service';

/** The slice of the connection manager readiness needs. */
export interface DatabaseProbe {
  state(): ConnectionState;
  ping(): Promise<boolean>;
}

export interface HealthDeps {
  readonly version: string;
  readonly uptimeSeconds: () => number;
  /** Absent only when no database is wired up at all. */
  readonly database?: DatabaseProbe | undefined;
}

export function buildLiveness(deps: HealthDeps): HealthResponse {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: deps.version,
    uptimeSeconds: Math.floor(deps.uptimeSeconds()),
  };
}

export async function resolveDatabaseStatus(
  database: DatabaseProbe | undefined,
): Promise<DependencyStatus> {
  if (database === undefined) return 'not_configured';

  switch (database.state()) {
    case 'connecting':
      // Distinct from 'unavailable': the service is mid-recovery, not stuck.
      return 'connecting';
    case 'stopped':
      return 'unavailable';
    case 'connected':
      return (await database.ping()) ? 'ok' : 'unavailable';
  }
}

export async function buildReadiness(
  deps: HealthDeps,
): Promise<{ body: ReadinessResponse; statusCode: number }> {
  const database = await resolveDatabaseStatus(deps.database);
  const status: HealthStatus = database === 'ok' ? 'ok' : 'degraded';

  return {
    body: { ...buildLiveness(deps), status, dependencies: { database } },
    // A load balancer must not route to an instance that cannot reach Mongo.
    statusCode: status === 'ok' ? 200 : 503,
  };
}
