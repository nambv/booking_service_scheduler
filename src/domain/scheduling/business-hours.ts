import { InvalidTimeRange, OutsideBusinessHours } from './errors.js';
import type { DealershipId } from './ids.js';
import type { TimeRange } from './time-range.js';

export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

export interface BusinessHours {
  readonly opensAt: TimeOfDay;
  readonly closesAt: TimeOfDay;
}

export function timeOfDay(hour: number, minute: number): TimeOfDay {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new InvalidTimeRange(`Hour must be 0-23, got ${String(hour)}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new InvalidTimeRange(`Minute must be 0-59, got ${String(minute)}`);
  }
  return { hour, minute };
}

export function parseTimeOfDay(value: string): TimeOfDay {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (match === null) {
    throw new InvalidTimeRange(`Expected HH:MM time of day, got '${value}'`);
  }
  return timeOfDay(Number(match[1]), Number(match[2]));
}

export function businessHours(opensAt: TimeOfDay, closesAt: TimeOfDay): BusinessHours {
  if (minuteOfDay(closesAt) <= minuteOfDay(opensAt)) {
    throw new InvalidTimeRange('Business hours must close after they open');
  }
  return { opensAt, closesAt };
}

function minuteOfDay(t: TimeOfDay): number {
  return t.hour * 60 + t.minute;
}

interface WallClock {
  /** Local calendar date as `YYYY-MM-DD`. */
  readonly date: string;
  readonly minuteOfDay: number;
}

/**
 * Projects a UTC instant onto the dealership's local wall clock.
 *
 * Business hours are a statement about the clock on the wall, not about elapsed
 * time, so the comparison has to happen in local time. Doing it this way is also
 * what makes DST transitions a non-event: on the day a region springs forward,
 * the 09:00-17:00 window is 9 hours of wall clock but 8 hours of real time, and
 * only the wall clock reading matters here.
 */
function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new InvalidTimeRange(`Time zone '${timeZone}' produced no ${type} component`);
    }
    return part.value;
  };

  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    minuteOfDay: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

export type BusinessHoursViolation = 'before_opening' | 'after_closing' | 'spans_multiple_days';

export function businessHoursViolation(
  range: TimeRange,
  timeZone: string,
  hours: BusinessHours,
): BusinessHoursViolation | null {
  const start = wallClock(range.start, timeZone);
  const end = wallClock(range.end, timeZone);

  if (start.date !== end.date) {
    return 'spans_multiple_days';
  }
  if (start.minuteOfDay < minuteOfDay(hours.opensAt)) {
    return 'before_opening';
  }
  // The closing instant itself is allowed: a job finishing exactly at 18:00 fits
  // inside a day that closes at 18:00.
  if (end.minuteOfDay > minuteOfDay(hours.closesAt)) {
    return 'after_closing';
  }
  return null;
}

export function isWithinBusinessHours(
  range: TimeRange,
  timeZone: string,
  hours: BusinessHours,
): boolean {
  return businessHoursViolation(range, timeZone, hours) === null;
}

export function assertWithinBusinessHours(
  range: TimeRange,
  timeZone: string,
  hours: BusinessHours,
  dealership: DealershipId,
): void {
  const violation = businessHoursViolation(range, timeZone, hours);
  if (violation !== null) {
    throw new OutsideBusinessHours(dealership, range, violation);
  }
}
