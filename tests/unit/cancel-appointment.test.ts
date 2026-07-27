import { describe, expect, it } from 'vitest';

import { cancelAppointment } from '../../src/application/scheduling/cancel-appointment.js';
import type { Appointment } from '../../src/domain/scheduling/entities.js';
import {
  AppointmentAlreadyStarted,
  EntityNotFound,
} from '../../src/domain/scheduling/errors.js';
import {
  appointmentId,
  serviceBayId,
  technicianId,
} from '../../src/domain/scheduling/ids.js';
import { timeRange } from '../../src/domain/scheduling/time-range.js';
import { GOLF, HARPER, LONDON, OIL_CHANGE, fakeRepository, fixedClock } from './fakes.js';

const NOW = '2026-08-03T06:00:00.000Z';
const clock = fixedClock(NOW);
const APPOINTMENT = appointmentId('70000000-0000-0000-0000-000000000001');

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: APPOINTMENT,
    customerId: HARPER,
    vehicleId: GOLF,
    dealershipId: LONDON,
    serviceTypeId: OIL_CHANGE,
    technicianId: technicianId('tech-1'),
    serviceBayId: serviceBayId('bay-1'),
    timeRange: timeRange(
      new Date('2026-08-03T10:00:00.000Z'),
      new Date('2026-08-03T10:30:00.000Z'),
    ),
    status: 'confirmed',
    ...overrides,
  };
}

describe('cancelAppointment', () => {
  it('flips a future confirmed appointment to cancelled', async () => {
    const repository = fakeRepository({ appointments: [appointment()] });

    const cancelled = await cancelAppointment(
      { repository, clock },
      { appointmentId: APPOINTMENT },
    );

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.id).toBe(APPOINTMENT);
  });

  it('rejects an unknown appointment with EntityNotFound', async () => {
    const repository = fakeRepository({ appointments: [] });

    await expect(
      cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT }),
    ).rejects.toThrow(EntityNotFound);
  });

  // DELETE is required to be idempotent, so a repeat must not fail.
  it('is idempotent — cancelling twice returns the cancelled appointment', async () => {
    const repository = fakeRepository({ appointments: [appointment()] });

    const first = await cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT });
    const second = await cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT });

    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('cancelled');
  });

  it('refuses to cancel an appointment whose service has already started', async () => {
    const started = appointment({
      timeRange: timeRange(
        new Date('2026-08-03T05:00:00.000Z'),
        new Date('2026-08-03T05:30:00.000Z'),
      ),
    });
    const repository = fakeRepository({ appointments: [started] });

    await expect(
      cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT }),
    ).rejects.toThrow(AppointmentAlreadyStarted);
  });

  it('refuses at the exact instant the service starts', async () => {
    const startingNow = appointment({
      timeRange: timeRange(new Date(NOW), new Date('2026-08-03T06:30:00.000Z')),
    });
    const repository = fakeRepository({ appointments: [startingNow] });

    await expect(
      cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT }),
    ).rejects.toThrow(AppointmentAlreadyStarted);
  });

  // Two callers cancelling at once: the conditional update matches for only one,
  // but both should see the desired end state rather than an error.
  it('treats losing the cancellation race as success, not failure', async () => {
    const repository = fakeRepository({
      appointments: [appointment()],
      markCancelledReturnsNothing: true,
    });

    const result = await cancelAppointment({ repository, clock }, { appointmentId: APPOINTMENT });

    expect(result.status).toBe('cancelled');
  });
});
