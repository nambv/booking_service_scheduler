import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

// node-postgres hands back `numeric` as a string to avoid precision loss. Every
// numeric column in this schema is a small integer, so the string is pure friction.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export interface DbOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export function createPool(options: DbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
