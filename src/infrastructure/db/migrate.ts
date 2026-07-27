import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Kysely } from 'kysely';
// Kysely 0.29 moved the migration API out of the package root.
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { Database } from './schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
  });
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration '${result.migrationName}' failed`);
    }
  }
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error(`Migration failed: ${JSON.stringify(error)}`);
  }
}
