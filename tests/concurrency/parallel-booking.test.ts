import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CUSTOMERS,
  DEALERSHIPS,
  LONDON_GEARBOX_TECHNICIAN,
  SERVICE_TYPES,
  VEHICLES,
} from '../../src/infrastructure/db/seed.js';
import { type Harness, frozenClock, startHarness } from '../integration/harness.js';

// This is the test that would have caught the naive read-then-write
// implementation, and the one to point at first in a review. It is deterministic
// by construction: Promise.all fires the requests together, and the assertions
// are on final counts, not on timing.

const clock = frozenClock('2026-08-03T06:00:00.000Z');

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

afterEach(async () => {
  await harness.reseed();
});

async function appointmentCount(): Promise<number> {
  const rows = await harness.db
    .selectFrom('appointment')
    .where('status', '=', 'confirmed')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .execute();
  return Number(rows[0]?.count ?? 0);
}

interface BookingOutcome {
  readonly statusCode: number;
  readonly code: string | undefined;
}

function fire(count: number, body: Record<string, string>): Promise<BookingOutcome[]> {
  return Promise.all(
    Array.from({ length: count }, async (): Promise<BookingOutcome> => {
      const response = await app.inject({ method: 'POST', url: '/appointments', payload: body });
      const parsed = response.json<{ error?: { code: string } }>();
      return { statusCode: response.statusCode, code: parsed.error?.code };
    }),
  );
}

describe('parallel booking into a single-pair slot', () => {
  // London has exactly one technician who can rebuild a gearbox, so the slot's
  // capacity is exactly one no matter how many bays are free.
  const gearboxAtLondon = {
    customerId: CUSTOMERS.harper,
    vehicleId: VEHICLES.harperGolf,
    dealershipId: DEALERSHIPS.london,
    serviceTypeId: SERVICE_TYPES.gearboxRebuild,
    startTime: '2026-08-03T08:00:00.000Z',
  };

  it('accepts exactly one of 20 identical concurrent requests', async () => {
    const results = await fire(20, gearboxAtLondon);

    const created = results.filter((r) => r.statusCode === 201);
    const conflicts = results.filter((r) => r.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(19);
    // The single most important assertion in the suite: the database holds one
    // row, not two, however the race resolved.
    expect(await appointmentCount()).toBe(1);
  });

  it('every rejection is a 409 that names why', async () => {
    const results = await fire(20, gearboxAtLondon);

    for (const result of results.filter((r) => r.statusCode !== 201)) {
      expect(result.statusCode).toBe(409);
      // Losers split between "someone took the slot mid-insert" (SLOT_ALREADY_TAKEN),
      // "nothing was free by the time I looked" (NO_QUALIFIED_TECHNICIAN), and the
      // rare deadlock that survived every retry (BOOKING_CONTENDED) — all 409.
      expect(['SLOT_ALREADY_TAKEN', 'NO_QUALIFIED_TECHNICIAN', 'BOOKING_CONTENDED']).toContain(
        result.code,
      );
    }
  });

  it('assigns the one winner to the single qualified technician', async () => {
    await fire(20, gearboxAtLondon);

    const rows = await harness.db
      .selectFrom('appointment')
      .select('technician_id')
      .where('status', '=', 'confirmed')
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.technician_id).toBe(LONDON_GEARBOX_TECHNICIAN);
  });
});

describe('parallel booking into a multi-capacity slot', () => {
  // Oil change at London: 4 qualified technicians, 5 bays. Capacity is 4. The
  // random tiebreak plus bounded re-selection must fill all 4 without ever
  // double-booking (assumptions A-014, A-021).
  const oilAtLondon = {
    customerId: CUSTOMERS.harper,
    vehicleId: VEHICLES.harperGolf,
    dealershipId: DEALERSHIPS.london,
    serviceTypeId: SERVICE_TYPES.oilChange,
    startTime: '2026-08-03T10:00:00.000Z',
  };

  it('fills the slot to its true capacity and no further', async () => {
    const results = await fire(20, oilAtLondon);

    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(4);
    expect(await appointmentCount()).toBe(4);
  });

  it('never assigns the same technician twice in the same slot', async () => {
    await fire(20, oilAtLondon);

    const rows = await harness.db
      .selectFrom('appointment')
      .select('technician_id')
      .where('status', '=', 'confirmed')
      .execute();

    const distinct = new Set(rows.map((r) => r.technician_id));
    expect(distinct.size).toBe(rows.length);
  });
});
