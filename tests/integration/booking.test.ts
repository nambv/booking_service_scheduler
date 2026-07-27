import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEALERSHIPS, SERVICE_TYPES, CUSTOMERS, VEHICLES } from '../../src/infrastructure/db/seed.js';
import { type Harness, frozenClock, startHarness } from './harness.js';

// Frozen at the start of the booking day so every same-day time is in the
// future — otherwise a before-opening time could also be before "now" and the
// past-check (which runs first) would mask the business-hours rejection.
const NOW = '2026-08-03T00:00:00.000Z';
const clock = frozenClock(NOW);

const post = (app: FastifyInstance, body: Record<string, string>): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/appointments', payload: body });

interface ErrorEnvelope {
  error: { code: string; bindingResource?: string };
}
const errorOf = (r: LightMyRequestResponse): ErrorEnvelope['error'] => r.json<ErrorEnvelope>().error;

interface AppointmentBody {
  id: string;
  status: string;
  startTime: string;
  endTime: string;
  dealershipId: string;
  technicianId: string;
}
const appointmentOf = (r: LightMyRequestResponse): AppointmentBody => r.json<AppointmentBody>();

interface AvailabilityBody {
  available: boolean;
  freeBays: number;
  freeQualifiedTechnicians: number;
  reason: string | null;
}
const availabilityOf = (r: LightMyRequestResponse): AvailabilityBody => r.json<AvailabilityBody>();

const validBody = {
  customerId: CUSTOMERS.harper,
  vehicleId: VEHICLES.harperGolf,
  dealershipId: DEALERSHIPS.london,
  serviceTypeId: SERVICE_TYPES.oilChange,
  startTime: '2026-08-03T09:00:00.000Z',
};

let harness: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  harness = await startHarness();
  app = harness.createApp(clock);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.reseed();
});

describe('POST /appointments — success', () => {
  it('creates an appointment and returns 201 with the derived end time', async () => {
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(201);
    const appointment = appointmentOf(response);
    expect(appointment.status).toBe('confirmed');
    expect(appointment.startTime).toBe('2026-08-03T09:00:00.000Z');
    // Oil change is 30 minutes; the client never sent an end time.
    expect(appointment.endTime).toBe('2026-08-03T09:30:00.000Z');
    expect(appointment.dealershipId).toBe(DEALERSHIPS.london);
  });

  it('echoes the correlation id and generates one when absent', async () => {
    const supplied = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: validBody,
      headers: { 'x-correlation-id': 'ticket-4711' },
    });
    expect(supplied.headers['x-correlation-id']).toBe('ticket-4711');

    const generated = await post(app, validBody);
    expect(generated.headers['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('persists exactly one row for one successful booking', async () => {
    await post(app, validBody);
    const rows = await harness.db
      .selectFrom('appointment')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .execute();
    expect(rows[0]?.count).toBe(1);
  });
});

describe('POST /appointments — validation (400)', () => {
  it('rejects a missing field', async () => {
    const response = await post(app, { customerId: CUSTOMERS.harper });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed start time', async () => {
    const response = await post(app, { ...validBody, startTime: 'yesterday' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-uuid id', async () => {
    const response = await post(app, { ...validBody, dealershipId: 'not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /appointments — domain rejections', () => {
  it('returns 404 when the dealership does not exist', async () => {
    const response = await post(app, {
      ...validBody,
      dealershipId: '00000000-0000-0000-0000-0000000000ff',
    });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('ENTITY_NOT_FOUND');
  });

  it('returns 422 for a range outside business hours', async () => {
    // 05:00 UTC is 06:00 London — before the 08:00 opening.
    const response = await post(app, { ...validBody, startTime: '2026-08-03T05:00:00.000Z' });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('OUTSIDE_BUSINESS_HOURS');
  });

  it('returns 422 for a long service that would run past closing', async () => {
    // Gearbox rebuild is 240 minutes; starting at 16:30 London (15:30 UTC) runs
    // to 20:30, past the 18:00 close.
    const response = await post(app, {
      ...validBody,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T15:30:00.000Z',
    });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('OUTSIDE_BUSINESS_HOURS');
  });

  it('returns 422 when the booking is in the past', async () => {
    const response = await post(app, { ...validBody, startTime: '2020-01-01T09:00:00.000Z' });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('BOOKING_IN_THE_PAST');
  });

  it('returns 409 naming the technician when none is qualified', async () => {
    // Manchester employs nobody who can rebuild a gearbox.
    const response = await post(app, {
      ...validBody,
      dealershipId: DEALERSHIPS.manchester,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T09:00:00.000Z',
    });
    expect(response.statusCode).toBe(409);
    const body = errorOf(response);
    expect(body.code).toBe('NO_QUALIFIED_TECHNICIAN');
    expect(body.bindingResource).toBe('technician');
  });
});

describe('touching appointments do not conflict', () => {
  it('allows a second booking that starts exactly when the first ends', async () => {
    // Both bookings pin the same single gearbox technician, so this proves the
    // half-open semantic end-to-end: 09:00-13:00 then 13:00-17:00 on one person.
    const first = await post(app, {
      ...validBody,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T08:00:00.000Z',
    });
    const second = await post(app, {
      ...validBody,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T12:00:00.000Z',
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(appointmentOf(first).technicianId).toBe(appointmentOf(second).technicianId);
  });
});

describe('DELETE /appointments/:id — cancellation frees the slot', () => {
  // London employs exactly one technician who can rebuild a gearbox, so this slot
  // has capacity for one. That makes "the slot was freed" unambiguous.
  const gearbox = {
    ...validBody,
    serviceTypeId: SERVICE_TYPES.gearboxRebuild,
    startTime: '2026-08-03T08:00:00.000Z',
  };

  const cancel = (id: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'DELETE', url: `/appointments/${id}` });

  it('frees the slot so the same time can be booked again', async () => {
    const first = await post(app, gearbox);
    expect(first.statusCode).toBe(201);

    // The slot is now full: the only qualified technician is busy.
    const blocked = await post(app, gearbox);
    expect(blocked.statusCode).toBe(409);

    const cancelled = await cancel(appointmentOf(first).id);
    expect(cancelled.statusCode).toBe(200);
    expect(appointmentOf(cancelled).status).toBe('cancelled');

    // No compensating write released anything — the exclusion constraints are
    // scoped to status = 'confirmed', so the row simply left their scope.
    const rebooked = await post(app, gearbox);
    expect(rebooked.statusCode).toBe(201);
  });

  it('leaves the cancelled row in place rather than deleting it', async () => {
    const booked = await post(app, gearbox);
    await cancel(appointmentOf(booked).id);

    const rows = await harness.db
      .selectFrom('appointment')
      .select(['id', 'status'])
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('is idempotent', async () => {
    const booked = await post(app, gearbox);
    const id = appointmentOf(booked).id;

    expect((await cancel(id)).statusCode).toBe(200);
    expect((await cancel(id)).statusCode).toBe(200);
  });

  it('returns 404 for an unknown appointment', async () => {
    const response = await cancel('00000000-0000-0000-0000-0000000000ff');
    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('ENTITY_NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    expect((await cancel('not-a-uuid')).statusCode).toBe(400);
  });

  it('refuses to cancel an appointment whose service has started', async () => {
    // The clock is frozen at midnight; this booking starts at 09:00 UTC. A second
    // app with a later clock sees the same row as already under way.
    const booked = await post(app, gearbox);
    const laterApp = harness.createApp(frozenClock('2026-08-03T09:00:00.000Z'));
    await laterApp.ready();

    const response = await laterApp.inject({
      method: 'DELETE',
      url: `/appointments/${appointmentOf(booked).id}`,
    });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('APPOINTMENT_ALREADY_STARTED');
  });
});

describe('GET /availability', () => {
  it('reports availability without taking the slot', async () => {
    const query = new URLSearchParams({
      dealershipId: DEALERSHIPS.london,
      serviceTypeId: SERVICE_TYPES.oilChange,
      startTime: '2026-08-03T09:00:00.000Z',
    });
    const response = await app.inject({ method: 'GET', url: `/availability?${query.toString()}` });

    expect(response.statusCode).toBe(200);
    const body = availabilityOf(response);
    expect(body.available).toBe(true);
    expect(body.freeBays).toBeGreaterThan(0);
    expect(body.freeQualifiedTechnicians).toBeGreaterThan(0);

    // Advisory only: it must not have created anything.
    const rows = await harness.db
      .selectFrom('appointment')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .execute();
    expect(rows[0]?.count).toBe(0);
  });

  it('reports unavailable with a reason when no technician is qualified', async () => {
    const query = new URLSearchParams({
      dealershipId: DEALERSHIPS.manchester,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T09:00:00.000Z',
    });
    const response = await app.inject({ method: 'GET', url: `/availability?${query.toString()}` });

    expect(response.statusCode).toBe(200);
    expect(availabilityOf(response).available).toBe(false);
    expect(availabilityOf(response).reason).toBe('no_qualified_technician');
  });
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    const ready = await app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json<{ status: string }>().status).toBe('ready');
  });
});

describe('metrics', () => {
  it('counts a confirmed booking and a rejection with distinct labels', async () => {
    // A dedicated app so the registry holds only this test's two attempts; the
    // shared app has booked many times by now.
    const meteredApp = harness.createApp(clock);
    await meteredApp.ready();

    await post(meteredApp, validBody);
    await post(meteredApp, {
      ...validBody,
      dealershipId: DEALERSHIPS.manchester,
      serviceTypeId: SERVICE_TYPES.gearboxRebuild,
      startTime: '2026-08-03T09:00:00.000Z',
    });

    const metrics = await meteredApp.inject({ url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');

    expect(metrics.body).toContain(
      `bookings_total{outcome="confirmed",dealership_id="${DEALERSHIPS.london}"} 1`,
    );
    expect(metrics.body).toContain(
      'booking_rejections_total{reason="NO_QUALIFIED_TECHNICIAN"} 1',
    );
    // The availability queries ran, so their histogram observed samples.
    expect(metrics.body).toMatch(/availability_query_duration_seconds_count \d+/);
  });
});
