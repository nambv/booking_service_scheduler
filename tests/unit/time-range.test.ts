import { describe, expect, it } from 'vitest';

import { InvalidTimeRange } from '../../src/domain/scheduling/errors.js';
import {
  containsInstant,
  durationInMinutes,
  equals,
  overlaps,
  timeRange,
  timeRangeFromDuration,
} from '../../src/domain/scheduling/time-range.js';

const at = (hhmm: string): Date => new Date(`2026-03-02T${hhmm}:00.000Z`);
const range = (from: string, to: string) => timeRange(at(from), at(to));

describe('timeRange construction', () => {
  it('accepts a range that ends after it starts', () => {
    const r = range('09:00', '10:00');
    expect(r.start.toISOString()).toBe('2026-03-02T09:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-03-02T10:00:00.000Z');
  });

  it('rejects a zero-length range', () => {
    expect(() => range('09:00', '09:00')).toThrow(InvalidTimeRange);
  });

  it('rejects an inverted range', () => {
    expect(() => range('10:00', '09:00')).toThrow(InvalidTimeRange);
  });

  it('rejects invalid dates', () => {
    expect(() => timeRange(new Date('nonsense'), at('10:00'))).toThrow(InvalidTimeRange);
    expect(() => timeRange(at('09:00'), new Date('nonsense'))).toThrow(InvalidTimeRange);
  });

  it('is immune to the caller mutating the dates it passed in', () => {
    const start = at('09:00');
    const end = at('10:00');
    const r = timeRange(start, end);

    start.setUTCFullYear(1999);
    end.setUTCFullYear(1999);

    expect(r.start.getUTCFullYear()).toBe(2026);
    expect(r.end.getUTCFullYear()).toBe(2026);
  });
});

describe('timeRangeFromDuration', () => {
  it('derives the end from the service duration', () => {
    const r = timeRangeFromDuration(at('09:00'), 90);
    expect(r.end.toISOString()).toBe('2026-03-02T10:30:00.000Z');
    expect(durationInMinutes(r)).toBe(90);
  });

  it('rejects a non-positive duration', () => {
    expect(() => timeRangeFromDuration(at('09:00'), 0)).toThrow(InvalidTimeRange);
    expect(() => timeRangeFromDuration(at('09:00'), -30)).toThrow(InvalidTimeRange);
  });

  it('rejects a fractional or non-finite duration', () => {
    expect(() => timeRangeFromDuration(at('09:00'), 30.5)).toThrow(InvalidTimeRange);
    expect(() => timeRangeFromDuration(at('09:00'), Number.NaN)).toThrow(InvalidTimeRange);
    expect(() => timeRangeFromDuration(at('09:00'), Number.POSITIVE_INFINITY)).toThrow(
      InvalidTimeRange,
    );
  });

  it('carries a long service across the hour and day correctly', () => {
    const r = timeRangeFromDuration(at('23:00'), 240);
    expect(r.end.toISOString()).toBe('2026-03-03T03:00:00.000Z');
  });
});

describe('overlaps — half-open [start, end) semantics', () => {
  it('identical ranges overlap', () => {
    expect(overlaps(range('09:00', '10:00'), range('09:00', '10:00'))).toBe(true);
  });

  // The single most important assertion in this file: back-to-back bookings are
  // legal, and a closed-interval implementation would get this wrong.
  it('touching ranges do NOT overlap, in either order', () => {
    const earlier = range('09:00', '10:00');
    const later = range('10:00', '11:00');
    expect(overlaps(earlier, later)).toBe(false);
    expect(overlaps(later, earlier)).toBe(false);
  });

  it('detects containment in both directions', () => {
    const outer = range('09:00', '12:00');
    const inner = range('10:00', '11:00');
    expect(overlaps(outer, inner)).toBe(true);
    expect(overlaps(inner, outer)).toBe(true);
  });

  it('detects partial overlap in both directions', () => {
    const earlier = range('09:00', '11:00');
    const later = range('10:00', '12:00');
    expect(overlaps(earlier, later)).toBe(true);
    expect(overlaps(later, earlier)).toBe(true);
  });

  it('shares a single instant when ranges overlap by one millisecond', () => {
    const a = timeRange(at('09:00'), new Date(at('10:00').getTime() + 1));
    const b = range('10:00', '11:00');
    expect(overlaps(a, b)).toBe(true);
  });

  it('returns false for disjoint ranges', () => {
    expect(overlaps(range('09:00', '10:00'), range('11:00', '12:00'))).toBe(false);
  });

  it('is symmetric across a spread of relative positions', () => {
    const fixed = range('10:00', '12:00');
    const others = [
      range('08:00', '09:00'),
      range('09:00', '10:00'),
      range('09:00', '11:00'),
      range('10:00', '12:00'),
      range('11:00', '13:00'),
      range('12:00', '13:00'),
      range('13:00', '14:00'),
    ];
    for (const other of others) {
      expect(overlaps(fixed, other)).toBe(overlaps(other, fixed));
    }
  });
});

describe('containsInstant', () => {
  it('includes the start instant and excludes the end instant', () => {
    const r = range('09:00', '10:00');
    expect(containsInstant(r, at('09:00'))).toBe(true);
    expect(containsInstant(r, at('09:30'))).toBe(true);
    expect(containsInstant(r, at('10:00'))).toBe(false);
    expect(containsInstant(r, at('08:59'))).toBe(false);
  });
});

describe('equals', () => {
  it('compares by instant, not by object identity', () => {
    expect(equals(range('09:00', '10:00'), range('09:00', '10:00'))).toBe(true);
    expect(equals(range('09:00', '10:00'), range('09:00', '11:00'))).toBe(false);
  });
});
