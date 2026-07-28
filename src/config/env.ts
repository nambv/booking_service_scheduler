import { existsSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Kept below the database's own limit so this service degrades before Postgres does. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export type Env = z.infer<typeof EnvSchema>;

let dotEnvLoaded = false;

/**
 * Populate `process.env` from a local `.env` file when one is present. Real
 * environment variables always win (Node does not overwrite existing keys), so
 * this only fills gaps for local development and a clean `git clone`. It is a
 * no-op in tests, which pass an explicit `source`, and in production, which ships
 * no `.env`. Requires Node >=22 for `process.loadEnvFile`.
 */
function loadDotEnvOnce(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  if (existsSync('.env')) {
    process.loadEnvFile();
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) {
    loadDotEnvOnce();
  }
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Configuration problems are the cheapest class of failure to catch, and the
    // most expensive to diagnose once the process is already serving traffic.
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return result.data;
}
