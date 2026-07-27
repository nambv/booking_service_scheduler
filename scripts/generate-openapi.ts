import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createDb, createPool } from '../src/infrastructure/db/client.js';
import { createApp } from '../src/infrastructure/http/app.js';

/**
 * Writes docs/openapi.yaml from the live route schemas.
 *
 * The contract is generated, never hand-written: a hand-written spec drifts from
 * the code silently, and nothing in the test suite would catch it. Run this
 * whenever the API surface changes (CLAUDE.md Definition of Done).
 *
 * A database connection is opened only because createApp requires one; no query
 * runs, so any reachable URL works.
 */
const OUTPUT = fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url));

const pool = createPool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://scheduler:scheduler@localhost:55432/scheduler',
  maxConnections: 1,
});
const db = createDb(pool);
const app = createApp({ db, logLevel: 'silent' });

try {
  await app.ready();
  const yaml = app.swagger({ yaml: true });
  await writeFile(OUTPUT, `${yaml.trimEnd()}\n`, 'utf8');
  process.stdout.write(`openapi written to ${OUTPUT}\n`);
} finally {
  await app.close();
  await db.destroy();
}
