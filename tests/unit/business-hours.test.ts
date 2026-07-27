import { describe, expect, it } from 'vitest';

import {
  assertWithinBusinessHours,
  businessHours,
  businessHoursViolation,
  isWithinBusinessHours,
  parseTimeOfDay,
  timeOfDay,
} from '../../src/domain/scheduling/business-hours.js';
import { InvalidTimeRange, OutsideBusinessHours } from '../../src/domain/scheduling/errors.js';
import { dealershipId } from '../../src/domain/scheduling/ids.js';
import { timeRange, timeRangeFromDuration } from '../../src/domain/scheduling/time-range.js';

const NINE_TO_SIX = businessHours(timeOfDay(9, 0), timeOfDay(18, 0));
const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const HO_CHI_MINH = 'Asia/Ho_Chi_Minh';
const A_DEALERSHIP = dealershipId('11111111-1111-1111-1111-111111111111');

describe('timeOfDay / parseTimeOfDay', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTimeOfDay('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay('18:30:00')).toEqual({ hour: 18, minute: 30 });
  });

  it('rejects malformed or out-of-range times', () => {
    expect(() => parseTimeOfDay('9:00')).toThrow(InvalidTimeRange);
    expect(() => parseTimeOfDay('24:00')).toThrow(InvalidTimeRange);
    expect(() => parseTimeOfDay('09:60')).toThrow(InvalidTimeRange);
    expect(() => parseTimeOfDay('')).toThrow(InvalidTimeRange);
  });

  it('rejects business hours that close before they open', () => {
    expect(() => businessHours(timeOfDay(18, 0), timeOfDay(9, 0))).toThrow(InvalidTimeRange);
    expect(() => businessHours(timeOfDay(9, 0), timeOfDay(9, 0))).toThrow(InvalidTimeRange);
  });
});

describe('business hours in a single time zone', () => {
  // London is UTC+0 in winter, so these UTC instants are also local wall time.
  const winter = (hhmm: string): Date => new Date(`2026-01-14T${hhmm}:00.000Z`);

  it('accepts a range comfortably inside the window', () => {
    const r = timeRange(winter('10:00'), winter('11:00'));
    expect(isWithinBusinessHours(r, LONDON, NINE_TO_SIX)).toBe(true);
  });

  it('accepts a range starting exactly at opening', () => {
    const r = timeRange(winter('09:00'), winter('10:00'));
    expect(businessHoursViolation(r, LONDON, NINE_TO_SIX)).toBeNull();
  });

  it('accepts a range ending exactly at closing', () => {
    const r = timeRange(winter('17:00'), winter('18:00'));
    expect(businessHoursViolation(r, LONDON, NINE_TO_SIX)).toBeNull();
  });

  it('rejects a range starting before opening', () => {
    const r = timeRange(winter('08:30'), winter('09:30'));
    expect(businessHoursViolation(r, LONDON, NINE_TO_SIX)).toBe('before_opening');
  });

  // CLAUDE.md section 6: a long service that would run past closing is rejected.
  it('rejects a long service that would run past closing', () => {
    const fourHourService = timeRangeFromDuration(winter('15:00'), 240);
    expect(businessHoursViolation(fourHourService, LONDON, NINE_TO_SIX)).toBe('after_closing');
  });

  it('accepts the same long service when it starts early enough to finish in time', () => {
    const fourHourService = timeRangeFromDuration(winter('14:00'), 240);
    expect(businessHoursViolation(fourHourService, LONDON, NINE_TO_SIX)).toBeNull();
  });

  it('rejects a range that spills into the next local day', () => {
    const r = timeRangeFromDuration(winter('23:00'), 120);
    expect(businessHoursViolation(r, LONDON, NINE_TO_SIX)).toBe('spans_multiple_days');
  });
});

describe('business hours are interpreted in the dealership time zone', () => {
  // 14:00 UTC is 09:00 in New York and 21:00 in Ho Chi Minh City. The same
  // instant is inside one dealership's window and outside another's.
  const instant = (hhmm: string): Date => new Date(`2026-01-14T${hhmm}:00.000Z`);

  it('accepts the instant for the dealership whose local clock is in range', () => {
    const r = timeRange(instant('14:00'), instant('15:00'));
    expect(isWithinBusinessHours(r, NEW_YORK, NINE_TO_SIX)).toBe(true);
  });

  it('rejects the same instant for a dealership on the other side of the world', () => {
    const r = timeRange(instant('14:00'), instant('15:00'));
    expect(businessHoursViolation(r, HO_CHI_MINH, NINE_TO_SIX)).toBe('after_closing');
  });
});

describe('daylight saving transitions', () => {
  // New York springs forward at 02:00 local on 2026-03-08. A 09:00-11:00 local
  // appointment that day is 2 hours of wall clock and must still be accepted.
  it('accepts a normal appointment on the spring-forward day', () => {
    const r = timeRange(
      new Date('2026-03-08T13:00:00.000Z'),
      new Date('2026-03-08T15:00:00.000Z'),
    );
    expect(businessHoursViolation(r, NEW_YORK, NINE_TO_SIX)).toBeNull();
  });

  // The identical UTC offset arithmetic would place this at 08:00 local if the
  // implementation had hard-coded the winter offset — before opening.
  it('uses the post-transition offset, not the pre-transition one', () => {
    const beforeTransition = timeRange(
      new Date('2026-03-07T13:00:00.000Z'),
      new Date('2026-03-07T15:00:00.000Z'),
    );
    expect(businessHoursViolation(beforeTransition, NEW_YORK, NINE_TO_SIX)).toBe('before_opening');
  });

  // Autumn back-shift: 2026-11-01. A 09:00 local start is 13:00 UTC that day.
  it('accepts a normal appointment on the fall-back day', () => {
    const r = timeRange(
      new Date('2026-11-01T14:00:00.000Z'),
      new Date('2026-11-01T16:00:00.000Z'),
    );
    expect(businessHoursViolation(r, NEW_YORK, NINE_TO_SIX)).toBeNull();
  });
});

describe('assertWithinBusinessHours', () => {
  it('throws a domain error carrying the reason and the dealership', () => {
    const r = timeRange(
      new Date('2026-01-14T07:00:00.000Z'),
      new Date('2026-01-14T08:00:00.000Z'),
    );
    try {
      assertWithinBusinessHours(r, LONDON, NINE_TO_SIX, A_DEALERSHIP);
      expect.unreachable('expected OutsideBusinessHours');
    } catch (error) {
      expect(error).toBeInstanceOf(OutsideBusinessHours);
      const domainError = error as OutsideBusinessHours;
      expect(domainError.code).toBe('OUTSIDE_BUSINESS_HOURS');
      expect(domainError.reason).toBe('before_opening');
      expect(domainError.dealershipId).toBe(A_DEALERSHIP);
    }
  });

  it('returns silently when the range fits', () => {
    const r = timeRange(
      new Date('2026-01-14T10:00:00.000Z'),
      new Date('2026-01-14T11:00:00.000Z'),
    );
    expect(() => assertWithinBusinessHours(r, LONDON, NINE_TO_SIX, A_DEALERSHIP)).not.toThrow();
  });
});
