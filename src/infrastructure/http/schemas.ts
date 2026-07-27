import { z } from 'zod';

// The boundary is the only place untyped input is tolerated. Everything past it
// works with parsed, typed values, which is what lets the domain layer contain
// no defensive checks.
//
// These schemas are attached to the Fastify routes rather than parsed inside the
// handlers, so they do three jobs at once: validate, type the handler, and
// generate docs/openapi.yaml. A hand-written spec can drift from the code; a
// generated one cannot.
//
// `guid` rather than `uuid`: ids are opaque 8-4-4-4-12 identifiers, and Zod's
// `uuid()` additionally enforces the RFC version nibble, which would reject
// perfectly valid keys that were not minted as RFC-4122 v1-8.

const Guid = z.guid().describe('An 8-4-4-4-12 identifier');
const Instant = z.iso.datetime({ offset: true }).describe('ISO 8601 instant with offset');

export const BookAppointmentBody = z
  .object({
    customerId: Guid,
    vehicleId: Guid,
    dealershipId: Guid,
    serviceTypeId: Guid,
    // The client supplies a start instant only. The end is derived from the
    // service type's duration server-side (A-003), so there is no endTime field.
    startTime: Instant,
  })
  .describe('A booking request. The end time is derived server-side from the service type.');

export type BookAppointmentBody = z.infer<typeof BookAppointmentBody>;

export const CheckAvailabilityQuery = z.object({
  dealershipId: Guid,
  serviceTypeId: Guid,
  startTime: Instant,
});

export type CheckAvailabilityQuery = z.infer<typeof CheckAvailabilityQuery>;

export const CancelAppointmentParams = z.object({
  id: Guid.describe('The appointment to cancel'),
});

export type CancelAppointmentParams = z.infer<typeof CancelAppointmentParams>;

export const AppointmentResponse = z
  .object({
    id: Guid,
    customerId: Guid,
    vehicleId: Guid,
    dealershipId: Guid,
    serviceTypeId: Guid,
    technicianId: Guid.describe(
      'Chosen by the server: the least-loaded qualified technician, ties broken at random',
    ),
    serviceBayId: Guid,
    startTime: Instant,
    endTime: Instant.describe('Exclusive: ranges are half-open [start, end)'),
    status: z.enum(['confirmed', 'cancelled']),
  })
  .describe('A confirmed appointment');

export const UnavailableReasonSchema = z.enum([
  'in_the_past',
  'before_opening',
  'after_closing',
  'spans_multiple_days',
  'no_bay_available',
  'no_qualified_technician',
]);

export const AvailabilityResponse = z
  .object({
    available: z.boolean(),
    startTime: Instant,
    endTime: Instant,
    freeBays: z.int().min(0),
    freeQualifiedTechnicians: z.int().min(0),
    reason: UnavailableReasonSchema.nullable().describe('Null when available'),
  })
  .describe(
    'Advisory only. A true result can still be followed by a 409 if another caller books first.',
  );

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z
        .enum([
          'VALIDATION_FAILED',
          'ENTITY_NOT_FOUND',
          'OUTSIDE_BUSINESS_HOURS',
          'BOOKING_IN_THE_PAST',
          'APPOINTMENT_ALREADY_STARTED',
          'INVALID_TIME_RANGE',
          'NO_BAY_AVAILABLE',
          'NO_QUALIFIED_TECHNICIAN',
          'SLOT_ALREADY_TAKEN',
          'BOOKING_CONTENDED',
          'INTERNAL_ERROR',
          'BAD_REQUEST',
        ])
        .describe('Stable machine-readable code'),
      message: z.string(),
      bindingResource: z
        .enum(['service_bay', 'technician'])
        .optional()
        .describe(
          'Which resource was the binding constraint. "Conflict" alone is not an acceptable 409 body.',
        ),
      details: z.looseObject({}).optional(),
    }),
  })
  .describe('Error envelope');

export const HealthResponse = z.object({ status: z.literal('ok') });
export const ReadyResponse = z.object({ status: z.enum(['ready', 'unavailable']) });
