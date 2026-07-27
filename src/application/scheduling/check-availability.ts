import { businessHoursViolation } from '../../domain/scheduling/business-hours.js';
import type { BusinessHoursViolation } from '../../domain/scheduling/business-hours.js';
import { EntityNotFound } from '../../domain/scheduling/errors.js';
import type { DealershipId, ServiceTypeId } from '../../domain/scheduling/ids.js';
import { timeRangeFromDuration } from '../../domain/scheduling/time-range.js';
import type { TimeRange } from '../../domain/scheduling/time-range.js';
import type { Clock, SchedulingRepository } from './ports.js';

export interface CheckAvailabilityQuery {
  readonly dealershipId: DealershipId;
  readonly serviceTypeId: ServiceTypeId;
  readonly startTime: Date;
}

export type UnavailableReason =
  | 'in_the_past'
  | 'no_bay_available'
  | 'no_qualified_technician'
  | BusinessHoursViolation;

export interface AvailabilityResult {
  readonly available: boolean;
  readonly requested: TimeRange;
  readonly freeBays: number;
  readonly freeQualifiedTechnicians: number;
  readonly reason: UnavailableReason | null;
}

/**
 * Answers "would a booking succeed right now" without taking the slot.
 *
 * The answer is advisory by construction: between this query and a subsequent
 * booking another caller can take the last pair, which is exactly why the
 * booking path does not trust its own availability read either (A-015).
 */
export async function checkAvailability(
  deps: { readonly repository: SchedulingRepository; readonly clock: Clock },
  query: CheckAvailabilityQuery,
): Promise<AvailabilityResult> {
  const { repository, clock } = deps;

  const [dealership, serviceType] = await Promise.all([
    repository.findDealership(query.dealershipId),
    repository.findServiceType(query.serviceTypeId),
  ]);

  if (dealership === undefined) {
    throw new EntityNotFound('Dealership', query.dealershipId);
  }
  if (serviceType === undefined) {
    throw new EntityNotFound('ServiceType', query.serviceTypeId);
  }

  const requested = timeRangeFromDuration(query.startTime, serviceType.durationMinutes);

  if (requested.start.getTime() < clock.now().getTime()) {
    return unavailable(requested, 'in_the_past');
  }

  const violation = businessHoursViolation(
    requested,
    dealership.timeZone,
    dealership.businessHours,
  );
  if (violation !== null) {
    return unavailable(requested, violation);
  }

  return repository.withTransaction(async (uow) => {
    const [bays, technicians] = await Promise.all([
      uow.findFreeBays(dealership, requested),
      uow.findFreeQualifiedTechnicians(dealership, serviceType.id, requested),
    ]);

    let reason: UnavailableReason | null = null;
    if (bays.length === 0) {
      reason = 'no_bay_available';
    } else if (technicians.length === 0) {
      reason = 'no_qualified_technician';
    }

    return {
      available: reason === null,
      requested,
      freeBays: bays.length,
      freeQualifiedTechnicians: technicians.length,
      reason,
    };
  });
}

function unavailable(requested: TimeRange, reason: UnavailableReason): AvailabilityResult {
  return { available: false, requested, freeBays: 0, freeQualifiedTechnicians: 0, reason };
}
