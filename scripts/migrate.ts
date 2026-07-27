import { loadEnv } from '../src/config/env.js';
import { createDb, createPool } from '../src/infrastructure/db/client.js';
import { migrateToLatest } from '../src/infrastructure/db/migrate.js';

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL, maxConnections: 2 });
const db = createDb(pool);

try {
  await migrateToLatest(db);
  process.stdout.write('migrations applied\n');
} finally {
  await db.destroy();
}
