import { loadEnv } from './config/env.js';
import { createDb, createPool } from './infrastructure/db/client.js';
import { createApp } from './infrastructure/http/app.js';
import { startTracing } from './infrastructure/observability/tracing.js';

const env = loadEnv();

// Register the tracer provider before the app so the span boundaries created in
// the handler and repository export. Console exporter only (design doc 8).
const tracing = startTracing();
const pool = createPool({
  connectionString: env.DATABASE_URL,
  maxConnections: env.DB_POOL_MAX,
});
const db = createDb(pool);
const app = createApp({ db, logLevel: env.LOG_LEVEL });

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  void app
    .close()
    .then(() => db.destroy())
    .then(() => tracing.shutdown())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await db.destroy();
  process.exit(1);
}
