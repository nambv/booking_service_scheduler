import { selectLeastLoaded } from '../../domain/scheduling/availability.js';
import { assertWithinBusinessHours } from '../../domain/scheduling/business-hours.js';
import type { Appointment } from '../../domain/scheduling/entities.js';
import {
  BookingInThePast,
  EntityNotFound,
  BookingContended,
  NoBayAvailable,
  NoQualifiedTechnician,
  SlotAlreadyTaken,
} from '../../domain/scheduling/errors.js';
import type {
  CustomerId,
  DealershipId,
  ServiceTypeId,
  VehicleId,
} from '../../domain/scheduling/ids.js';
import { timeRangeFromDuration } from '../../domain/scheduling/time-range.js';
import type { Clock, SchedulingRepository } from './ports.js';

export interface BookAppointmentCommand {
  readonly customerId: CustomerId;
  readonly vehicleId: VehicleId;
  readonly dealershipId: DealershipId;
  readonly serviceTypeId: ServiceTypeId;
  /** The end is derived from the service type; clients never supply it (A-003). */
  readonly startTime: Date;
}

export interface BookAppointmentDeps {
  readonly repository: SchedulingRepository;
  readonly clock: Clock;
}

/**
 * How many times a booking will re-select resources after losing a race.
 *
 * Why this exists: the selection policy is deterministic (A-014), so concurrent
 * requests for the same slot all pick the same lowest-id pair, collide on the
 * exclusion constraint, and only one survives — even when other technicians are
 * free. Measured on seed data: 12 concurrent bookings into a slot with capacity
 * for 4 produced 1 success and 11 conflicts.
 *
 * Why re-selecting is not the "silent retry" that A-015 rules out: the caller
 * asks for a dealership, a service and a start time. The technician and bay are
 * ours to choose, so choosing a different one changes nothing the caller asked
 * for. Retrying at a different *time* would, and is still refused.
 *
 * Each attempt is a fresh transaction, and that is load-bearing rather than
 * incidental. A failed statement aborts its transaction in Postgres, so retrying
 * inside one is impossible without savepoints — and a new transaction takes a
 * new snapshot, which is precisely what makes the winning row visible so the
 * next attempt stops choosing the resource that just lost.
 */
const MAX_SELECTION_ATTEMPTS = 3;

export async function bookAppointment(
  deps: BookAppointmentDeps,
  command: BookAppointmentCommand,
): Promise<Appointment> {
  const { repository, clock } = deps;

  const [dealership, serviceType, customer, vehicle] = await Promise.all([
    repository.findDealership(command.dealershipId),
    repository.findServiceType(command.serviceTypeId),
    repository.findCustomer(command.customerId),
    repository.findVehicle(command.vehicleId),
  ]);

  if (dealership === undefined) {
    throw new EntityNotFound('Dealership', command.dealershipId);
  }
  if (serviceType === undefined) {
    throw new EntityNotFound('ServiceType', command.serviceTypeId);
  }
  if (customer === undefined) {
    throw new EntityNotFound('Customer', command.customerId);
  }
  if (vehicle === undefined) {
    throw new EntityNotFound('Vehicle', command.vehicleId);
  }
  // Vehicle ownership is deliberately not checked against the customer: that is
  // an authorisation question and this service has no identity context (A-017).

  const range = timeRangeFromDuration(command.startTime, serviceType.durationMinutes);

  const now = clock.now();
  if (range.start.getTime() < now.getTime()) {
    throw new BookingInThePast(range.start, now);
  }

  assertWithinBusinessHours(range, dealership.timeZone, dealership.businessHours, dealership.id);

  let lastConflict: SlotAlreadyTaken | BookingContended | undefined;

  for (let attempt = 1; attempt <= MAX_SELECTION_ATTEMPTS; attempt += 1) {
    try {
      return await repository.withTransaction(async (uow) => {
        // These two queries produce a useful rejection, not a guarantee. The
        // guarantee is the exclusion constraint that fires on insert below.
        const [bays, technicians] = await Promise.all([
          uow.findFreeBays(dealership, range),
          uow.findFreeQualifiedTechnicians(dealership, serviceType.id, range),
        ]);

        const bay = selectLeastLoaded(bays);
        if (bay === undefined) {
          throw new NoBayAvailable(dealership.id, range);
        }

        const technician = selectLeastLoaded(technicians);
        if (technician === undefined) {
          throw new NoQualifiedTechnician(dealership.id, serviceType.id, range);
        }

        return uow.insertAppointment({
          customerId: customer.id,
          vehicleId: vehicle.id,
          dealershipId: dealership.id,
          serviceTypeId: serviceType.id,
          technicianId: technician.id,
          serviceBayId: bay.id,
          timeRange: range,
        });
      });
    } catch (error) {
      // Both are transient contention on the same slot: SlotAlreadyTaken means a
      // rival committed first, BookingContended means the insert deadlocked. Each
      // is retried on a fresh transaction, whose new snapshot makes the winner
      // visible so the next attempt selects around it.
      if (!(error instanceof SlotAlreadyTaken) && !(error instanceof BookingContended)) {
        throw error;
      }
      lastConflict = error;
    }
  }

  throw lastConflict ?? new SlotAlreadyTaken('service_bay');
}
