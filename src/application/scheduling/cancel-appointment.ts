import type { Appointment } from '../../domain/scheduling/entities.js';
import { AppointmentAlreadyStarted, EntityNotFound } from '../../domain/scheduling/errors.js';
import type { AppointmentId } from '../../domain/scheduling/ids.js';
import type { Clock, SchedulingRepository } from './ports.js';

export interface CancelAppointmentCommand {
  readonly appointmentId: AppointmentId;
}

export interface CancelAppointmentDeps {
  readonly repository: SchedulingRepository;
  readonly clock: Clock;
}

/**
 * Cancels an appointment and, as a direct consequence, frees its slot.
 *
 * There is no code here that releases the bay or the technician, because there is
 * nothing to release: both exclusion constraints carry `WHERE status =
 * 'confirmed'`, so flipping the status removes the row from the constraint's
 * scope and the slot becomes bookable in the same transaction. That predicate was
 * added in the first migration precisely so this would be a status change rather
 * than a constraint rebuild on a populated table (assumptions A-002).
 *
 * The operation is idempotent: cancelling an already-cancelled appointment
 * returns it unchanged rather than failing, which is what HTTP requires of DELETE
 * (assumptions A-024).
 */
export async function cancelAppointment(
  deps: CancelAppointmentDeps,
  command: CancelAppointmentCommand,
): Promise<Appointment> {
  const { repository, clock } = deps;

  const existing = await repository.findAppointment(command.appointmentId);
  if (existing === undefined) {
    throw new EntityNotFound('Appointment', command.appointmentId);
  }
  if (existing.status === 'cancelled') {
    return existing;
  }

  const now = clock.now();
  if (existing.timeRange.start.getTime() <= now.getTime()) {
    throw new AppointmentAlreadyStarted(existing.timeRange.start, now);
  }

  const cancelled = await repository.markCancelled(command.appointmentId);
  if (cancelled !== undefined) {
    return cancelled;
  }

  // The conditional update matched nothing, so a concurrent caller cancelled it
  // between the read and the write. That is the desired end state, not an error.
  const afterRace = await repository.findAppointment(command.appointmentId);
  if (afterRace === undefined) {
    throw new EntityNotFound('Appointment', command.appointmentId);
  }
  return afterRace;
}
