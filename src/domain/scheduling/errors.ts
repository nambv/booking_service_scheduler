import type { DealershipId, ServiceTypeId } from './ids.js';
import type { TimeRange } from './time-range.js';

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTimeRange extends DomainError {
  readonly code = 'INVALID_TIME_RANGE';
}

export class EntityNotFound extends DomainError {
  readonly code = 'ENTITY_NOT_FOUND';

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} '${id}' does not exist`);
  }
}

export class OutsideBusinessHours extends DomainError {
  readonly code = 'OUTSIDE_BUSINESS_HOURS';

  constructor(
    readonly dealershipId: DealershipId,
    readonly requested: TimeRange,
    readonly reason: 'before_opening' | 'after_closing' | 'spans_multiple_days',
  ) {
    super(`Requested range falls outside business hours (${reason})`);
  }
}

/**
 * Rejects a booking whose start time has already passed (assumptions A-008).
 * Like OutsideBusinessHours this is a well-formed request asking for something
 * the business does not allow, so it maps to 422 rather than 400.
 */
export class BookingInThePast extends DomainError {
  readonly code = 'BOOKING_IN_THE_PAST';

  constructor(
    readonly requestedStart: Date,
    readonly now: Date,
  ) {
    super('Appointments cannot be booked in the past');
  }
}

// The two "nothing was available" rejections and the "someone took it first"
// rejection are all HTTP 409, but they are different operational events and the
// ratio between them is a real signal about contention. They stay distinct all
// the way to the response body and the metrics labels.
export class NoBayAvailable extends DomainError {
  readonly code = 'NO_BAY_AVAILABLE';

  constructor(
    readonly dealershipId: DealershipId,
    readonly requested: TimeRange,
  ) {
    super('No service bay is free for the entire requested range');
  }
}

export class NoQualifiedTechnician extends DomainError {
  readonly code = 'NO_QUALIFIED_TECHNICIAN';

  constructor(
    readonly dealershipId: DealershipId,
    readonly serviceTypeId: ServiceTypeId,
    readonly requested: TimeRange,
  ) {
    super('No technician qualified for this service type is free for the entire requested range');
  }
}

export class SlotAlreadyTaken extends DomainError {
  readonly code = 'SLOT_ALREADY_TAKEN';

  constructor(readonly resource: 'service_bay' | 'technician') {
    super(`The selected ${resource} was booked by a concurrent request`);
  }
}

/**
 * Cancelling an appointment whose service has already begun (assumptions A-023).
 * Like OutsideBusinessHours this is a well-formed request the business does not
 * allow, so it maps to 422 rather than 409 — nothing is contended, the state is
 * simply no longer cancellable.
 */
export class AppointmentAlreadyStarted extends DomainError {
  readonly code = 'APPOINTMENT_ALREADY_STARTED';

  constructor(
    readonly startedAt: Date,
    readonly now: Date,
  ) {
    super('An appointment cannot be cancelled once its service has started');
  }
}

/**
 * A deadlock detected while inserting under contention (SQLSTATE 40P01).
 *
 * The exclusion constraints are backed by gist indexes, and concurrent inserts
 * of overlapping ranges can take index locks in an order Postgres resolves by
 * aborting one transaction. This is transient by definition — the loser did not
 * necessarily lose the slot — so it is retried on a fresh transaction rather than
 * surfaced. It reaches HTTP only if every retry also deadlocks, where 409 (a
 * contention conflict the client may retry) is the honest status.
 */
export class BookingContended extends DomainError {
  readonly code = 'BOOKING_CONTENDED';
}
