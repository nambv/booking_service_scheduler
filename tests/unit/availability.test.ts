import { describe, expect, it } from 'vitest';

import {
  belongsToDealership,
  isFree,
  isQualified,
  selectLeastLoaded,
} from '../../src/domain/scheduling/availability.js';
import type { ServiceBay, Technician } from '../../src/domain/scheduling/entities.js';
import {
  dealershipId,
  serviceBayId,
  serviceTypeId,
  technicianId,
} from '../../src/domain/scheduling/ids.js';
import { timeRange } from '../../src/domain/scheduling/time-range.js';

const DEALERSHIP_A = dealershipId('aaaaaaaa-0000-0000-0000-000000000001');
const DEALERSHIP_B = dealershipId('bbbbbbbb-0000-0000-0000-000000000002');
const OIL_CHANGE = serviceTypeId('50000000-0000-0000-0000-000000000001');
const GEARBOX_REBUILD = serviceTypeId('50000000-0000-0000-0000-000000000002');

const at = (hhmm: string): Date => new Date(`2026-03-02T${hhmm}:00.000Z`);
const range = (from: string, to: string) => timeRange(at(from), at(to));

function technician(id: string, skills: readonly string[], dealership = DEALERSHIP_A): Technician {
  return {
    id: technicianId(id),
    dealershipId: dealership,
    name: `Technician ${id}`,
    skills: new Set(skills.map(serviceTypeId)),
  };
}

describe('isQualified', () => {
  it('accepts a technician holding the service type as a skill', () => {
    const tech = technician('t1', [OIL_CHANGE, GEARBOX_REBUILD]);
    expect(isQualified(tech, OIL_CHANGE)).toBe(true);
  });

  // The rejection that matters: being free is not enough.
  it('rejects a free technician who lacks the skill', () => {
    const tech = technician('t2', [OIL_CHANGE]);
    expect(isQualified(tech, GEARBOX_REBUILD)).toBe(false);
  });

  it('rejects a technician with no skills at all', () => {
    const tech = technician('t3', []);
    expect(isQualified(tech, OIL_CHANGE)).toBe(false);
  });
});

describe('isFree', () => {
  it('is free when nothing is booked', () => {
    expect(isFree([], range('09:00', '10:00'))).toBe(true);
  });

  it('is free when existing bookings only touch the candidate range', () => {
    const occupied = [range('08:00', '09:00'), range('10:00', '11:00')];
    expect(isFree(occupied, range('09:00', '10:00'))).toBe(true);
  });

  // The other rejection that matters: holding the skill is not enough either.
  it('is not free when a skilled technician is already busy in that range', () => {
    const occupied = [range('09:30', '10:30')];
    expect(isFree(occupied, range('09:00', '10:00'))).toBe(false);
  });

  it('is not free when the candidate range is fully contained in a booking', () => {
    expect(isFree([range('08:00', '12:00')], range('09:00', '10:00'))).toBe(false);
  });

  it('is not free when the candidate range fully contains a booking', () => {
    expect(isFree([range('09:30', '09:45')], range('09:00', '10:00'))).toBe(false);
  });

  it('scans every existing booking, not just the first', () => {
    const occupied = [range('06:00', '07:00'), range('07:00', '08:00'), range('09:30', '10:30')];
    expect(isFree(occupied, range('09:00', '10:00'))).toBe(false);
  });
});

describe('selectLeastLoaded', () => {
  const bay = (id: string, appointmentsOnDate: number) => ({
    id: serviceBayId(id),
    appointmentsOnDate,
  });

  it('returns undefined when there are no candidates', () => {
    expect(selectLeastLoaded([])).toBeUndefined();
  });

  it('picks the candidate with the fewest appointments that day', () => {
    const chosen = selectLeastLoaded([bay('b1', 4), bay('b2', 1), bay('b3', 3)]);
    expect(chosen?.id).toBe(serviceBayId('b2'));
  });

  it('never lets randomness override a strictly lower load', () => {
    const candidates = [bay('b1', 4), bay('b2', 1), bay('b3', 3)];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(selectLeastLoaded(candidates, () => r)?.id).toBe(serviceBayId('b2'));
    }
  });

  it('breaks ties using the injected source of randomness', () => {
    const tied = [bay('b1', 2), bay('b2', 2), bay('b3', 2)];
    // Reservoir sampling always keeps the incumbent when the draw is high, and
    // always swaps when it is zero, so these two ends pin down the traversal.
    expect(selectLeastLoaded(tied, () => 0.999)?.id).toBe(serviceBayId('b1'));
    expect(selectLeastLoaded(tied, () => 0)?.id).toBe(serviceBayId('b3'));
  });

  // The property that matters under load: every equally-loaded candidate must be
  // reachable, otherwise concurrent requests pile onto one resource.
  it('can reach every equally-loaded candidate', () => {
    const tied = [bay('b1', 2), bay('b2', 2), bay('b3', 2)];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const chosen = selectLeastLoaded(tied);
      if (chosen !== undefined) {
        seen.add(chosen.id);
      }
    }
    expect(seen).toEqual(new Set([serviceBayId('b1'), serviceBayId('b2'), serviceBayId('b3')]));
  });

  it('picks the strictly least loaded regardless of the order it arrives in', () => {
    const candidates = [bay('b3', 2), bay('b1', 2), bay('b2', 1)];
    const reversed = [...candidates].reverse();
    expect(selectLeastLoaded(candidates)?.id).toBe(serviceBayId('b2'));
    expect(selectLeastLoaded(reversed)?.id).toBe(serviceBayId('b2'));
  });

  it('handles a single candidate', () => {
    expect(selectLeastLoaded([bay('b1', 9)])?.id).toBe(serviceBayId('b1'));
  });
});

describe('belongsToDealership', () => {
  it('accepts a resource at the requested dealership', () => {
    expect(belongsToDealership(technician('t1', []), DEALERSHIP_A)).toBe(true);
  });

  it('rejects a resource belonging to another dealership', () => {
    expect(belongsToDealership(technician('t1', [], DEALERSHIP_B), DEALERSHIP_A)).toBe(false);
  });

  it('applies to bays as well as technicians', () => {
    const serviceBay: ServiceBay = {
      id: serviceBayId('b1'),
      dealershipId: DEALERSHIP_B,
      name: 'Bay 1',
    };
    expect(belongsToDealership(serviceBay, DEALERSHIP_A)).toBe(false);
    expect(belongsToDealership(serviceBay, DEALERSHIP_B)).toBe(true);
  });
});
