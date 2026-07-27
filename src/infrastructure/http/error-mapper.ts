import {
  AppointmentAlreadyStarted,
  BookingContended,
  BookingInThePast,
  DomainError,
  EntityNotFound,
  InvalidTimeRange,
  NoBayAvailable,
  NoQualifiedTechnician,
  OutsideBusinessHours,
  SlotAlreadyTaken,
} from '../../domain/scheduling/errors.js';

export interface ErrorBody {
  readonly error: {
    /** Stable machine code, e.g. NO_QUALIFIED_TECHNICIAN. */
    readonly code: string;
    readonly message: string;
    /**
     * For 409s, the resource that was the binding constraint. "Conflict" alone
     * is not an acceptable body (CLAUDE.md section 5.3).
     */
    readonly bindingResource?: 'service_bay' | 'technician';
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export interface MappedError {
  readonly status: number;
  readonly body: ErrorBody;
}

/**
 * The single place a domain error becomes an HTTP status. Route handlers throw
 * domain errors; they never build a failure response themselves. Anything that
 * is not a DomainError is deliberately not mapped here — it is an unexpected
 * fault and belongs in the 500 path, which must not leak its message.
 */
export function mapDomainError(error: DomainError): MappedError {
  if (error instanceof EntityNotFound) {
    return build(404, error, { entity: error.entity, id: error.id });
  }
  if (error instanceof OutsideBusinessHours) {
    return build(422, error, { reason: error.reason });
  }
  if (error instanceof BookingInThePast) {
    return build(422, error, { requestedStart: error.requestedStart.toISOString() });
  }
  if (error instanceof AppointmentAlreadyStarted) {
    return build(422, error, { startedAt: error.startedAt.toISOString() });
  }
  if (error instanceof InvalidTimeRange) {
    return build(422, error);
  }
  if (error instanceof NoBayAvailable) {
    return build(409, error, undefined, 'service_bay');
  }
  if (error instanceof NoQualifiedTechnician) {
    return build(409, error, undefined, 'technician');
  }
  if (error instanceof SlotAlreadyTaken) {
    return build(409, error, undefined, error.resource);
  }
  // A deadlock that survived every retry: a genuine contention conflict the
  // client may retry. It cannot name a single binding resource, because a
  // deadlock is about the ordering of concurrent inserts, not about one being full.
  if (error instanceof BookingContended) {
    return build(409, error, { retryable: true });
  }
  // Exhaustiveness guard: a new DomainError subclass that is not handled above
  // becomes a 500 rather than silently defaulting to a misleading status.
  return {
    status: 500,
    body: { error: { code: error.code, message: 'Unhandled domain error' } },
  };
}

function build(
  status: number,
  error: DomainError,
  details?: Readonly<Record<string, unknown>>,
  bindingResource?: 'service_bay' | 'technician',
): MappedError {
  return {
    status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(bindingResource !== undefined ? { bindingResource } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}
