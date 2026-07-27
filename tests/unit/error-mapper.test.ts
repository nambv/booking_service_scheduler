import { describe, expect, it } from 'vitest';

import {
  BookingContended,
  BookingInThePast,
  EntityNotFound,
  InvalidTimeRange,
  NoBayAvailable,
  NoQualifiedTechnician,
  OutsideBusinessHours,
  SlotAlreadyTaken,
} from '../../src/domain/scheduling/errors.js';
import { dealershipId, serviceTypeId } from '../../src/domain/scheduling/ids.js';
import { timeRange } from '../../src/domain/scheduling/time-range.js';
import { mapDomainError } from '../../src/infrastructure/http/error-mapper.js';

const LONDON = dealershipId('10000000-0000-0000-0000-000000000001');
const OIL = serviceTypeId('20000000-0000-0000-0000-000000000001');
const range = timeRange(
  new Date('2026-08-03T10:00:00.000Z'),
  new Date('2026-08-03T10:30:00.000Z'),
);

describe('mapDomainError — status codes from CLAUDE.md 5.3', () => {
  it('maps EntityNotFound to 404 with the entity and id', () => {
    const mapped = mapDomainError(new EntityNotFound('Dealership', 'abc'));
    expect(mapped.status).toBe(404);
    expect(mapped.body.error.code).toBe('ENTITY_NOT_FOUND');
    expect(mapped.body.error.details).toEqual({ entity: 'Dealership', id: 'abc' });
  });

  it('maps OutsideBusinessHours to 422 carrying the reason', () => {
    const mapped = mapDomainError(new OutsideBusinessHours(LONDON, range, 'after_closing'));
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.details).toEqual({ reason: 'after_closing' });
  });

  it('maps BookingInThePast to 422', () => {
    const mapped = mapDomainError(
      new BookingInThePast(range.start, new Date('2026-08-03T12:00:00.000Z')),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe('BOOKING_IN_THE_PAST');
  });

  it('maps InvalidTimeRange to 422', () => {
    expect(mapDomainError(new InvalidTimeRange('bad')).status).toBe(422);
  });
});

describe('mapDomainError — 409s name the binding resource', () => {
  it('maps NoBayAvailable to 409 naming service_bay', () => {
    const mapped = mapDomainError(new NoBayAvailable(LONDON, range));
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.bindingResource).toBe('service_bay');
  });

  it('maps NoQualifiedTechnician to 409 naming technician', () => {
    const mapped = mapDomainError(new NoQualifiedTechnician(LONDON, OIL, range));
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.bindingResource).toBe('technician');
  });

  it('maps SlotAlreadyTaken to 409 carrying the resource that lost the race', () => {
    expect(mapDomainError(new SlotAlreadyTaken('technician')).body.error.bindingResource).toBe(
      'technician',
    );
    expect(mapDomainError(new SlotAlreadyTaken('service_bay')).body.error.bindingResource).toBe(
      'service_bay',
    );
  });

  it('maps BookingContended to a retryable 409', () => {
    const mapped = mapDomainError(new BookingContended('deadlocked'));
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe('BOOKING_CONTENDED');
    expect(mapped.body.error.details).toEqual({ retryable: true });
  });

  // "Conflict" alone is not an acceptable body — every 409 must say which
  // resource was the constraint (or, for a deadlock, that it is retryable).
  it('never emits a 409 without a binding resource', () => {
    for (const error of [
      new NoBayAvailable(LONDON, range),
      new NoQualifiedTechnician(LONDON, OIL, range),
      new SlotAlreadyTaken('service_bay'),
    ]) {
      const mapped = mapDomainError(error);
      expect(mapped.status).toBe(409);
      expect(mapped.body.error.bindingResource).toBeDefined();
    }
  });
});
