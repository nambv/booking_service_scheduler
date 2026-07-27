import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Clock } from '../../src/application/scheduling/ports.js';
import { createDb, createPool } from '../../src/infrastructure/db/client.js';
import { migrateToLatest } from '../../src/infrastructure/db/migrate.js';
import type { Database } from '../../src/infrastructure/db/schema.js';
import { seed } from '../../src/infrastructure/db/seed.js';
import { createApp } from '../../src/infrastructure/http/app.js';

export interface Harness {
  readonly db: Kysely<Database>;
  createApp(clock?: Clock): FastifyInstance;
  reseed(): Promise<void>;
  stop(): Promise<void>;
}

// One real Postgres per test file. A mock cannot exercise an exclusion
// constraint, so the one guarantee this project exists to make would be exactly
// the thing a mock-based suite could not verify (design doc section 7).
export async function startHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();

  const pool = createPool({ connectionString: container.getConnectionUri(), maxConnections: 30 });
  const db = createDb(pool);

  await migrateToLatest(db);
  await seed(db);

  const apps: FastifyInstance[] = [];

  return {
    db,
    createApp(clock?: Clock): FastifyInstance {
      const app = createApp({ db, logLevel: 'silent', ...(clock !== undefined ? { clock } : {}) });
      apps.push(app);
      return app;
    },
    async reseed(): Promise<void> {
      await seed(db);
    },
    async stop(): Promise<void> {
      await Promise.all(apps.map((app) => app.close()));
      await db.destroy();
      await container.stop();
    },
  };
}

/** A clock frozen at an instant, so "is this in the past?" is deterministic. */
export function frozenClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: (): Date => new Date(instant.getTime()) };
}
