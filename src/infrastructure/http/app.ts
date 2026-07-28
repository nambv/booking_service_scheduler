import { randomUUID } from 'node:crypto';

import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';

import { bookAppointment } from '../../application/scheduling/book-appointment.js';
import { cancelAppointment } from '../../application/scheduling/cancel-appointment.js';
import { checkAvailability } from '../../application/scheduling/check-availability.js';
import type { Clock } from '../../application/scheduling/ports.js';
import { systemClock } from '../../application/scheduling/ports.js';
import { DomainError } from '../../domain/scheduling/errors.js';
import {
  appointmentId,
  customerId,
  dealershipId,
  serviceTypeId,
  vehicleId,
} from '../../domain/scheduling/ids.js';
import type { Database } from '../db/schema.js';
import { createSchedulingRepository } from '../db/scheduling.repository.js';
import { type Metrics, createMetrics } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { mapDomainError } from './error-mapper.js';
import {
  AppointmentResponse,
  AvailabilityResponse,
  BookAppointmentBody,
  CancelAppointmentParams,
  CheckAvailabilityQuery,
  ErrorResponse,
  HealthResponse,
  ReadyResponse,
} from './schemas.js';
import { serialiseAppointment, serialiseAvailability } from './serialisers.js';

const CORRELATION_HEADER = 'x-correlation-id';

export interface AppOptions {
  readonly db: Kysely<Database>;
  readonly clock?: Clock;
  readonly logLevel?: string;
  /** Injectable so tests can assert on a fresh registry; defaults to a new one. */
  readonly metrics?: Metrics;
}

export function createApp(options: AppOptions): FastifyInstance {
  const clock = options.clock ?? systemClock;
  const metrics = options.metrics ?? createMetrics();
  const repository = createSchedulingRepository(options.db, {
    onAvailabilityQuery: (seconds) => metrics.availabilityQueryDuration.observe(seconds),
  });

  const app = Fastify({
    // A support ticket quoting one correlation id must retrieve the whole story
    // of a booking attempt, so the id is the log's request marker throughout.
    genReqId: (req) => {
      const header = req.headers[CORRELATION_HEADER];
      return typeof header === 'string' && header.length > 0 ? header : randomUUID();
    },
    requestIdHeader: CORRELATION_HEADER,
    // The request id is the correlation id; pino logs it under its default
    // `reqId` field. Renaming that field to `correlationId` is only available in
    // Fastify 5 through a deprecated option, so the field keeps its default name
    // and the value — the same id echoed in the x-correlation-id header — is what
    // ties a support ticket to its logs.
    logger: {
      level: options.logLevel ?? 'info',
      // Never log PII (CLAUDE.md observability): customer name, email, phone,
      // and full VINs are redacted wherever they might appear in serialised objects.
      redact: {
        paths: [
          'req.headers.authorization',
          '*.email',
          '*.phone',
          '*.vin',
          '*.customerName',
        ],
        censor: '[redacted]',
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod schemas declared on the routes do three jobs: validate at the boundary,
  // type the handlers, and generate the OpenAPI document. CLAUDE.md requires the
  // contract to be generated from the route schemas rather than hand-written,
  // precisely so it cannot drift from the code.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', (_req, reply, payload, done) => {
    void reply.header(CORRELATION_HEADER, reply.request.id);
    done(null, payload);
  });

  registerDocs(app);

  // Routes must load *after* the swagger plugin, because @fastify/swagger
  // discovers them through an onRoute hook it installs when it loads — and
  // `register` is deferred, so routes added synchronously here would be invisible
  // to it and the generated document would contain no paths. Wrapping them in a
  // plugin puts them behind swagger in avvio's load order.
  void app.register((instance, _opts, done) => {
    registerScheduling(instance, repository, clock, metrics);
    registerOperations(instance, options.db, metrics);
    done();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ outcome: 'rejected', reason: 'validation' }, 'request failed validation');
      // Reshape to a minimal, stable {field, message} rather than passing Zod's
      // raw issue objects through: those leak internal schema paths and the
      // validation regex, and would be inconsistent with the curated details of
      // domain errors. instancePath is `/vehicleId`; strip the leading slash.
      const issues = error.validation.map((issue) => ({
        field: issue.instancePath.replace(/^\//, '') || '(body)',
        message: issue.message,
      }));
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request failed schema validation',
          details: { issues },
        },
      });
    }

    if (error instanceof DomainError) {
      const mapped = mapDomainError(error);
      // Only the booking route produces these rejections; counting them here
      // keeps the reason label — no_bay / no_technician / slot_taken / … — in one
      // place, which is where the contention signal is read (design doc 8).
      metrics.bookingRejectionsTotal.inc({ reason: error.code });
      request.log.info(
        { outcome: 'rejected', reason: error.code, status: mapped.status },
        'domain rejection',
      );
      return reply.code(mapped.status).send(mapped.body);
    }

    // Fastify's own body-parser errors carry a statusCode; honour it rather than
    // turning a malformed-JSON 400 into a 500.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      });
    }

    // Unexpected fault: log it in full, but never leak the message to the client.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  return app;
}

function registerDocs(app: FastifyInstance): void {
  void app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Unified Service Scheduler',
        version: '0.1.0',
        description: [
          'Books vehicle service appointments at a dealership. A booking is confirmed only when',
          'both a service bay and a technician qualified for the requested service are free for',
          'the entire duration of the job.',
          '',
          'The non-overlap invariant is enforced by PostgreSQL `EXCLUDE USING gist` constraints,',
          'not by application code. `GET /availability` is advisory: between checking and booking,',
          'another caller can take the last pair, which is why a booking can still return 409.',
          '',
          'Time ranges are half-open `[start, end)`. An appointment ending at 10:00 and one',
          'starting at 10:00 do not conflict.',
        ].join('\n'),
        license: {
          name: 'Proprietary — technical assessment submission',
          identifier: 'LicenseRef-Proprietary',
        },
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      tags: [
        { name: 'Scheduling', description: 'Booking and availability' },
        { name: 'Operations', description: 'Health and metrics' },
      ],
      // No authentication, deliberately: this service has no identity context and
      // treats customerId as trusted input (assumptions A-001, A-017). An empty
      // array is the explicit statement of that, not an omission.
      security: [],
    },
    transform: jsonSchemaTransform,
  });

  void app.register(fastifySwaggerUi, {
    routePrefix: '/swagger',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // The plugin serves the UI at `/swagger/`. `/swagger/index.html` is the URL
  // people habitually type, so it is aliased rather than left as a 404.
  app.get('/swagger/index.html', (_request, reply) => reply.redirect('/swagger/', 308));
}

function registerScheduling(
  app: FastifyInstance,
  repository: ReturnType<typeof createSchedulingRepository>,
  clock: Clock,
  metrics: Metrics,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/appointments',
    {
      schema: {
        operationId: 'bookAppointment',
        tags: ['Scheduling'],
        summary: 'Book an appointment',
        description:
          'The client supplies a start instant only; the end is derived from the service ' +
          "type's duration, so a caller cannot understate a job to fit a gap. On losing a " +
          'race for the last free pair the service re-selects a different technician or bay ' +
          'for the same time, up to a bounded number of attempts. It never moves the booking ' +
          'to a different time.',
        body: BookAppointmentBody,
        response: {
          201: AppointmentResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const stopTimer = metrics.bookingDuration.startTimer();

      const appointment = await withSpan('book_appointment', () =>
        bookAppointment(
          { repository, clock },
          {
            customerId: customerId(body.customerId),
            vehicleId: vehicleId(body.vehicleId),
            dealershipId: dealershipId(body.dealershipId),
            serviceTypeId: serviceTypeId(body.serviceTypeId),
            startTime: new Date(body.startTime),
          },
        ),
      );

      // Timed and counted only on success here; the error handler owns the
      // rejection outcome so the two paths never double-count.
      stopTimer({ outcome: 'confirmed' });
      metrics.bookingsTotal.inc({ outcome: 'confirmed', dealership_id: appointment.dealershipId });

      request.log.info(
        { outcome: 'confirmed', appointmentId: appointment.id },
        'appointment booked',
      );
      return reply.code(201).send(serialiseAppointment(appointment));
    },
  );

  typed.delete(
    '/appointments/:id',
    {
      schema: {
        operationId: 'cancelAppointment',
        tags: ['Scheduling'],
        summary: 'Cancel an appointment and free its slot',
        description:
          'Flipping the status to `cancelled` frees the bay and the technician immediately, ' +
          "because both exclusion constraints are scoped to `WHERE status = 'confirmed'`. " +
          'No compensating write is needed. Idempotent: cancelling an already-cancelled ' +
          'appointment returns it unchanged. An appointment whose service has already ' +
          'started cannot be cancelled.',
        params: CancelAppointmentParams,
        response: {
          200: AppointmentResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          422: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const cancelled = await withSpan('cancel_appointment', () =>
        cancelAppointment({ repository, clock }, { appointmentId: appointmentId(request.params.id) }),
      );

      metrics.cancellationsTotal.inc({ dealership_id: cancelled.dealershipId });
      request.log.info(
        { outcome: 'cancelled', appointmentId: cancelled.id },
        'appointment cancelled',
      );
      return reply.code(200).send(serialiseAppointment(cancelled));
    },
  );

  typed.get(
    '/availability',
    {
      schema: {
        operationId: 'checkAvailability',
        tags: ['Scheduling'],
        summary: 'Check whether a booking would succeed',
        description:
          'Advisory only — it does not take the slot. A true result can still be followed by ' +
          'a 409 from POST /appointments if another caller books in between.',
        querystring: CheckAvailabilityQuery,
        response: {
          200: AvailabilityResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const query = request.query;

      const result = await checkAvailability(
        { repository, clock },
        {
          dealershipId: dealershipId(query.dealershipId),
          serviceTypeId: serviceTypeId(query.serviceTypeId),
          startTime: new Date(query.startTime),
        },
      );

      return reply.code(200).send(serialiseAvailability(result));
    },
  );
}

function registerOperations(
  app: FastifyInstance,
  db: Kysely<Database>,
  metrics: Metrics,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Liveness: the process is up. Kept separate from readiness so an orchestrator
  // restarts a wedged process but not a healthy one during a brief database blip.
  typed.get(
    '/health',
    {
      schema: {
        operationId: 'health',
        tags: ['Operations'],
        summary: 'Liveness',
        response: { 200: HealthResponse },
      },
    },
    // Async because the Zod type provider requires an awaitable return type.
    async (_request, reply) => reply.code(200).send({ status: 'ok' as const }),
  );

  typed.get(
    '/health/ready',
    {
      schema: {
        operationId: 'healthReady',
        tags: ['Operations'],
        summary: 'Readiness — verifies database connectivity',
        response: { 200: ReadyResponse, 503: ReadyResponse },
      },
    },
    async (_request, reply) => {
      try {
        await db.executeQuery({ sql: 'SELECT 1', parameters: [] } as never);
        return reply.code(200).send({ status: 'ready' as const });
      } catch {
        return reply.code(503).send({ status: 'unavailable' as const });
      }
    },
  );

  // No response schema: this endpoint returns the Prometheus text exposition
  // format, not JSON, and the Zod serializer would quote it as a JSON string.
  // The content type is set explicitly on the reply instead.
  app.get(
    '/metrics',
    {
      schema: {
        operationId: 'metrics',
        tags: ['Operations'],
        summary: 'Prometheus metrics',
        description: 'Returns `text/plain; version=0.0.4` — the Prometheus text exposition format.',
      },
    },
    async (_request, reply) => {
      const body = await metrics.registry.metrics();
      return reply.header('content-type', metrics.registry.contentType).code(200).send(body);
    },
  );
}
