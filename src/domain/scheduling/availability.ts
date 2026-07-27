import type { ServiceBay, Technician } from './entities.js';
import type { ServiceTypeId } from './ids.js';
import type { TimeRange } from './time-range.js';
import { overlaps } from './time-range.js';

/**
 * The rules in this file are the definition of "available". The repository
 * evaluates the same rules in SQL for speed, but this is where they are stated
 * once, in a form that can be tested without a database.
 */

export function isQualified(technician: Technician, serviceType: ServiceTypeId): boolean {
  return technician.skills.has(serviceType);
}

/**
 * A resource is free for a candidate range when none of the ranges it already
 * holds overlaps it. Absences — shifts, leave, sickness — can be fed in as
 * blocking ranges without changing this rule at all (assumptions A-013).
 */
export function isFree(occupied: readonly TimeRange[], candidate: TimeRange): boolean {
  return !occupied.some((existing) => overlaps(existing, candidate));
}

export interface ResourceLoad {
  /** Confirmed appointments this resource already holds on the requested date. */
  readonly appointmentsOnDate: number;
}

/**
 * Least-loaded selection, breaking ties uniformly at random (assumptions A-014).
 *
 * The randomness is not cosmetic. An earlier version broke ties on lowest id,
 * which made every concurrent request for the same slot choose the same pair and
 * collide on the exclusion constraint: 12 concurrent bookings into a slot with
 * capacity for 4 filled 1 of the 4, rising to 2.6 of 4 once bounded re-selection
 * was added. Randomising the tie takes it to 4 of 4. Determinism here was
 * actively harmful under load.
 *
 * `random` is a parameter so the domain stays a pure function and the choice can
 * be pinned down exactly in tests.
 */
export function selectLeastLoaded<T extends ResourceLoad & { readonly id: string }>(
  candidates: readonly T[],
  random: () => number = Math.random,
): T | undefined {
  let chosen: T | undefined;
  let tiedSoFar = 0;

  for (const candidate of candidates) {
    if (chosen === undefined || candidate.appointmentsOnDate < chosen.appointmentsOnDate) {
      chosen = candidate;
      tiedSoFar = 1;
    } else if (candidate.appointmentsOnDate === chosen.appointmentsOnDate) {
      // Reservoir sampling: each of the k equally-loaded candidates ends up
      // chosen with probability exactly 1/k, in a single pass.
      tiedSoFar += 1;
      if (random() < 1 / tiedSoFar) {
        chosen = candidate;
      }
    }
  }
  return chosen;
}

export function belongsToDealership(
  resource: ServiceBay | Technician,
  dealership: ServiceBay['dealershipId'],
): boolean {
  return resource.dealershipId === dealership;
}
