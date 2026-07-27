import { InvalidTimeRange } from './errors.js';

/**
 * A half-open interval `[start, end)`.
 *
 * The instant `end` is NOT part of the range. An appointment ending at 10:00 and
 * one starting at 10:00 therefore do not conflict. Closed intervals would make
 * every pair of back-to-back appointments collide on their shared boundary.
 */
export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

const MS_PER_MINUTE = 60_000;

export function timeRange(start: Date, end: Date): TimeRange {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new InvalidTimeRange('Time range endpoints must be valid dates');
  }
  if (end.getTime() <= start.getTime()) {
    throw new InvalidTimeRange('Time range must end strictly after it starts');
  }
  // Copying defends the interface's readonly promise against a caller that
  // mutates the Date it passed in.
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

export function timeRangeFromDuration(start: Date, durationMinutes: number): TimeRange {
  if (!Number.isFinite(durationMinutes) || !Number.isInteger(durationMinutes)) {
    throw new InvalidTimeRange('Duration must be a whole number of minutes');
  }
  if (durationMinutes <= 0) {
    throw new InvalidTimeRange('Duration must be positive');
  }
  if (Number.isNaN(start.getTime())) {
    throw new InvalidTimeRange('Time range endpoints must be valid dates');
  }
  return timeRange(start, new Date(start.getTime() + durationMinutes * MS_PER_MINUTE));
}

/**
 * The overlap predicate for half-open ranges, and the single definition of
 * "these two bookings conflict" in the system. The SQL side expresses the same
 * rule as `tstzrange && tstzrange`.
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function containsInstant(range: TimeRange, instant: Date): boolean {
  const t = instant.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

export function durationInMinutes(range: TimeRange): number {
  return (range.end.getTime() - range.start.getTime()) / MS_PER_MINUTE;
}

export function equals(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}
