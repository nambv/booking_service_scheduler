import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * The organising question for these metrics is "what would we need to know at
 * 03:00 when advisors report bookings failing?" — is it ours or theirs, one
 * dealership or all, contention or a bug. The labels are chosen to answer that
 * and no more: dealership_id is a bounded set, but technician_id and customer_id
 * are unbounded and are never label values.
 */
export interface Metrics {
  readonly registry: Registry;
  readonly bookingsTotal: Counter<'outcome' | 'dealership_id'>;
  readonly bookingRejectionsTotal: Counter<'reason'>;
  readonly cancellationsTotal: Counter<'dealership_id'>;
  readonly bookingDuration: Histogram<'outcome'>;
  readonly availabilityQueryDuration: Histogram;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const bookingsTotal = new Counter({
    name: 'bookings_total',
    help: 'Booking attempts by outcome and dealership',
    labelNames: ['outcome', 'dealership_id'] as const,
    registers: [registry],
  });

  // Separates no_bay / no_technician / outside_hours / slot_taken / contended.
  // A spike in slot_taken specifically means contention is rising — a different
  // response from a spike in no_technician.
  const bookingRejectionsTotal = new Counter({
    name: 'booking_rejections_total',
    help: 'Booking rejections by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  // Cancellations free capacity, so a rising cancellation rate explains a falling
  // rejection rate without any change in demand — the two are read together.
  const cancellationsTotal = new Counter({
    name: 'cancellations_total',
    help: 'Appointments cancelled, by dealership',
    labelNames: ['dealership_id'] as const,
    registers: [registry],
  });

  const bookingDuration = new Histogram({
    name: 'booking_duration_seconds',
    help: 'Wall-clock duration of a booking attempt including the transaction',
    labelNames: ['outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  // The first thing to degrade as the appointment table grows, so it is measured
  // apart from the total booking time.
  const availabilityQueryDuration = new Histogram({
    name: 'availability_query_duration_seconds',
    help: 'Duration of the candidate availability queries',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
    registers: [registry],
  });

  return {
    registry,
    bookingsTotal,
    bookingRejectionsTotal,
    cancellationsTotal,
    bookingDuration,
    availabilityQueryDuration,
  };
}
