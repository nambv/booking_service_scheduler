import { describe, expect, it } from 'vitest';

import { bookAppointment } from '../../src/application/scheduling/book-appointment.js';
import type { BookAppointmentCommand } from '../../src/application/scheduling/book-appointment.js';
import {
  BookingInThePast,
  EntityNotFound,
  NoBayAvailable,
  NoQualifiedTechnician,
  OutsideBusinessHours,
  SlotAlreadyTaken,
} from '../../src/domain/scheduling/errors.js';
import { appointmentId, serviceBayId, technicianId } from '../../src/domain/scheduling/ids.js';
import { durationInMinutes } from '../../src/domain/scheduling/time-range.js';
import {
  GOLF,
  HARPER,
  LONDON,
  OIL_CHANGE,
  fakeRepository,
  fixedClock,
} from './fakes.js';

const NOW = '2026-08-03T06:00:00.000Z';
// 10:00 UTC is 11:00 in London during BST — comfortably inside 08:00-18:00.
const START = new Date('2026-08-03T10:00:00.000Z');

const command: BookAppointmentCommand = {
  customerId: HARPER,
  vehicleId: GOLF,
  dealershipId: LONDON,
  serviceTypeId: OIL_CHANGE,
  startTime: START,
};

const clock = fixedClock(NOW);

describe('bookAppointment — happy path', () => {
  it('derives the end time from the service type rather than the client', async () => {
    const repository = fakeRepository();
    const appointment = await bookAppointment({ repository, clock }, command);

    expect(durationInMinutes(appointment.timeRange)).toBe(30);
    expect(appointment.timeRange.start.toISOString()).toBe(START.toISOString());
    expect(appointment.timeRange.end.toISOString()).toBe('2026-08-03T10:30:00.000Z');
  });

  it('does the availability read and the insert inside a single transaction', async () => {
    const repository = fakeRepository();
    await bookAppointment({ repository, clock }, command);
    expect(repository.transactionCount()).toBe(1);
    expect(repository.inserted).toHaveLength(1);
  });

  it('applies the least-loaded selection policy to both resources', async () => {
    const repository = fakeRepository({
      // Loads are distinct so the assertion pins down the policy rather than the
      // random tiebreak, which has its own tests in availability.test.ts.
      bays: [
        { id: serviceBayId('bay-3'), appointmentsOnDate: 5 },
        { id: serviceBayId('bay-1'), appointmentsOnDate: 2 },
        { id: serviceBayId('bay-2'), appointmentsOnDate: 3 },
      ],
      technicians: [
        { id: technicianId('tech-9'), appointmentsOnDate: 1 },
        { id: technicianId('tech-4'), appointmentsOnDate: 0 },
      ],
    });

    const appointment = await bookAppointment({ repository, clock }, command);

    expect(appointment.serviceBayId).toBe(serviceBayId('bay-1'));
    expect(appointment.technicianId).toBe(technicianId('tech-4'));
  });
});

describe('bookAppointment — entity resolution', () => {
  it.each([
    ['dealership', { dealership: undefined }, 'Dealership'],
    ['service type', { serviceType: undefined }, 'ServiceType'],
    ['customer', { customer: undefined }, 'Customer'],
    ['vehicle', { vehicle: undefined }, 'Vehicle'],
  ])('rejects a missing %s with EntityNotFound', async (_label, overrides, entityName) => {
    const repository = fakeRepository(overrides);
    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(EntityNotFound);
    try {
      await bookAppointment({ repository, clock }, command);
    } catch (error) {
      expect((error as EntityNotFound).entity).toBe(entityName);
    }
  });

  it('does not open a transaction when an entity is missing', async () => {
    const repository = fakeRepository({ dealership: undefined });
    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(EntityNotFound);
    expect(repository.transactionCount()).toBe(0);
  });
});

describe('bookAppointment — time rules', () => {
  it('rejects a booking whose start has already passed', async () => {
    const repository = fakeRepository();
    const lateClock = fixedClock('2026-08-03T11:00:00.000Z');
    await expect(bookAppointment({ repository, clock: lateClock }, command)).rejects.toThrow(
      BookingInThePast,
    );
    expect(repository.transactionCount()).toBe(0);
  });

  it('rejects a range outside the dealership business hours', async () => {
    const repository = fakeRepository();
    // 05:00 UTC is 06:00 London — before the 08:00 opening.
    const tooEarly = { ...command, startTime: new Date('2026-08-03T05:00:00.000Z') };
    const earlyClock = fixedClock('2026-08-01T00:00:00.000Z');

    await expect(bookAppointment({ repository, clock: earlyClock }, tooEarly)).rejects.toThrow(
      OutsideBusinessHours,
    );
    expect(repository.transactionCount()).toBe(0);
  });
});

describe('bookAppointment — resource rejections', () => {
  it('reports the bay as the binding constraint when no bay is free', async () => {
    const repository = fakeRepository({ bays: [] });
    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(NoBayAvailable);
  });

  it('reports the technician as the binding constraint when none is qualified and free', async () => {
    const repository = fakeRepository({ technicians: [] });
    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(
      NoQualifiedTechnician,
    );
  });

  // Both are 409, but they are different events and must stay distinguishable.
  it('carries the dealership and requested range on the rejection', async () => {
    const repository = fakeRepository({ bays: [] });
    try {
      await bookAppointment({ repository, clock }, command);
      expect.unreachable('expected NoBayAvailable');
    } catch (error) {
      const rejection = error as NoBayAvailable;
      expect(rejection.code).toBe('NO_BAY_AVAILABLE');
      expect(rejection.dealershipId).toBe(LONDON);
      expect(rejection.requested.start.toISOString()).toBe(START.toISOString());
    }
  });

  it('gives up with SlotAlreadyTaken after a bounded number of attempts', async () => {
    let attempts = 0;
    const repository = fakeRepository({
      onInsert: () => {
        attempts += 1;
        return Promise.reject(new SlotAlreadyTaken('service_bay'));
      },
    });

    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(SlotAlreadyTaken);
    // Bounded: a caller waiting on a permanently contended slot must not wait
    // indefinitely, and the database must not be hammered.
    expect(attempts).toBe(3);
    expect(repository.transactionCount()).toBe(3);
  });

  it('re-selects and succeeds when a different resource is still free', async () => {
    let attempts = 0;
    const repository = fakeRepository({
      onInsert: (appointment) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new SlotAlreadyTaken('technician'));
        }
        return Promise.resolve({
          id: appointmentId('70000000-0000-0000-0000-000000000002'),
          ...appointment,
          status: 'confirmed' as const,
        });
      },
    });

    const appointment = await bookAppointment({ repository, clock }, command);
    expect(appointment.status).toBe('confirmed');
    expect(attempts).toBe(2);
  });

  // Re-selection applies only to losing the race. A rejection that means
  // "nothing is available" must not be retried — the answer will not change.
  it('does not retry when the availability query found nothing', async () => {
    const repository = fakeRepository({ technicians: [] });
    await expect(bookAppointment({ repository, clock }, command)).rejects.toThrow(
      NoQualifiedTechnician,
    );
    expect(repository.transactionCount()).toBe(1);
  });
});
