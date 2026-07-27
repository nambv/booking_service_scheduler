import { loadEnv } from '../src/config/env.js';
import { createDb, createPool } from '../src/infrastructure/db/client.js';
import { seed } from '../src/infrastructure/db/seed.js';

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL, maxConnections: 2 });
const db = createDb(pool);

try {
  await seed(db);
  process.stdout.write('seed data applied\n');
} finally {
  await db.destroy();
}
