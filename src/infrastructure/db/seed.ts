import type { Kysely } from 'kysely';

import type { Database } from './schema.js';

/**
 * Seed data is a test fixture, not a realistic data set. It is shaped so that
 * every rejection path in the system is reachable by hand from the README's
 * cURL examples (assumptions A-018) — in particular the skill matrix has
 * deliberate gaps so "no qualified technician" is not a hypothetical.
 *
 * Ids are fixed rather than generated so the documented examples stay valid.
 */

export const SERVICE_TYPES = {
  oilChange: '20000000-0000-0000-0000-000000000001',
  tyreRotation: '20000000-0000-0000-0000-000000000002',
  diagnostics: '20000000-0000-0000-0000-000000000003',
  brakeService: '20000000-0000-0000-0000-000000000004',
  annualService: '20000000-0000-0000-0000-000000000005',
  gearboxRebuild: '20000000-0000-0000-0000-000000000006',
} as const;

export const DEALERSHIPS = {
  london: '10000000-0000-0000-0000-000000000001',
  manchester: '10000000-0000-0000-0000-000000000002',
  hoChiMinh: '10000000-0000-0000-0000-000000000003',
} as const;

const serviceTypeRows = [
  { id: SERVICE_TYPES.oilChange, name: 'Oil Change', duration_minutes: 30 },
  { id: SERVICE_TYPES.tyreRotation, name: 'Tyre Rotation', duration_minutes: 45 },
  { id: SERVICE_TYPES.diagnostics, name: 'Diagnostics', duration_minutes: 60 },
  { id: SERVICE_TYPES.brakeService, name: 'Brake Service', duration_minutes: 90 },
  { id: SERVICE_TYPES.annualService, name: 'Annual Service', duration_minutes: 120 },
  { id: SERVICE_TYPES.gearboxRebuild, name: 'Gearbox Rebuild', duration_minutes: 240 },
];

const dealershipRows = [
  {
    id: DEALERSHIPS.london,
    name: 'Keyloop Motors London',
    timezone: 'Europe/London',
    opens_at: '08:00:00',
    closes_at: '18:00:00',
  },
  {
    id: DEALERSHIPS.manchester,
    name: 'Keyloop Motors Manchester',
    timezone: 'Europe/London',
    opens_at: '09:00:00',
    closes_at: '17:00:00',
  },
  {
    id: DEALERSHIPS.hoChiMinh,
    name: 'Keyloop Motors Ho Chi Minh',
    timezone: 'Asia/Ho_Chi_Minh',
    opens_at: '08:00:00',
    closes_at: '17:00:00',
  },
];

export function bayId(dealershipIndex: number, n: number): string {
  return `30000000-0000-0000-000${dealershipIndex}-00000000000${n}`;
}

export function technicianId(dealershipIndex: number, n: number): string {
  return `40000000-0000-0000-000${dealershipIndex}-00000000000${n}`;
}

/** London employs exactly one technician qualified for a gearbox rebuild. */
export const LONDON_GEARBOX_TECHNICIAN = technicianId(1, 1);

const bayRows = [
  ...Array.from({ length: 5 }, (_, i) => ({
    id: bayId(1, i + 1),
    dealership_id: DEALERSHIPS.london,
    name: `Bay ${String(i + 1)}`,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: bayId(2, i + 1),
    dealership_id: DEALERSHIPS.manchester,
    name: `Bay ${String(i + 1)}`,
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: bayId(3, i + 1),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: `Bay ${String(i + 1)}`,
  })),
];

interface TechnicianSeed {
  readonly id: string;
  readonly dealership_id: string;
  readonly name: string;
  readonly skills: readonly string[];
}

const ALL_BUT_GEARBOX = [
  SERVICE_TYPES.oilChange,
  SERVICE_TYPES.tyreRotation,
  SERVICE_TYPES.diagnostics,
  SERVICE_TYPES.brakeService,
  SERVICE_TYPES.annualService,
];

const technicianSeeds: readonly TechnicianSeed[] = [
  // London: broad coverage, but exactly one technician can rebuild a gearbox.
  // That makes contention for a 240-minute job reproducible by hand.
  {
    id: technicianId(1, 1),
    dealership_id: DEALERSHIPS.london,
    name: 'Alex Rivera',
    skills: [...ALL_BUT_GEARBOX, SERVICE_TYPES.gearboxRebuild],
  },
  {
    id: technicianId(1, 2),
    dealership_id: DEALERSHIPS.london,
    name: 'Sam Okafor',
    skills: ALL_BUT_GEARBOX,
  },
  {
    id: technicianId(1, 3),
    dealership_id: DEALERSHIPS.london,
    name: 'Priya Nair',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.tyreRotation, SERVICE_TYPES.diagnostics],
  },
  {
    id: technicianId(1, 4),
    dealership_id: DEALERSHIPS.london,
    name: 'Jordan Blake',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.brakeService],
  },
  {
    id: technicianId(1, 5),
    dealership_id: DEALERSHIPS.london,
    name: 'Mika Lindqvist',
    skills: [SERVICE_TYPES.annualService, SERVICE_TYPES.diagnostics],
  },

  // Manchester: nobody here is qualified for a gearbox rebuild at all, so
  // NoQualifiedTechnician is reachable without first filling the calendar.
  {
    id: technicianId(2, 1),
    dealership_id: DEALERSHIPS.manchester,
    name: 'Dana Whitfield',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.tyreRotation],
  },
  {
    id: technicianId(2, 2),
    dealership_id: DEALERSHIPS.manchester,
    name: 'Tomas Varga',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.brakeService, SERVICE_TYPES.diagnostics],
  },
  {
    id: technicianId(2, 3),
    dealership_id: DEALERSHIPS.manchester,
    name: 'Ruth Adeyemi',
    skills: [SERVICE_TYPES.annualService, SERVICE_TYPES.brakeService],
  },
  {
    id: technicianId(2, 4),
    dealership_id: DEALERSHIPS.manchester,
    name: 'Elliot Chen',
    skills: [SERVICE_TYPES.tyreRotation, SERVICE_TYPES.diagnostics],
  },

  // Ho Chi Minh: a different time zone, so business-hours rejections can be
  // demonstrated with the same UTC instant that succeeds in London.
  {
    id: technicianId(3, 1),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Nguyen Van An',
    skills: [...ALL_BUT_GEARBOX, SERVICE_TYPES.gearboxRebuild],
  },
  {
    id: technicianId(3, 2),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Tran Thi Mai',
    skills: ALL_BUT_GEARBOX,
  },
  {
    id: technicianId(3, 3),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Le Minh Duc',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.tyreRotation],
  },
  {
    id: technicianId(3, 4),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Pham Hoang Long',
    skills: [SERVICE_TYPES.brakeService, SERVICE_TYPES.diagnostics],
  },
  {
    id: technicianId(3, 5),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Vo Thi Lan',
    skills: [SERVICE_TYPES.annualService],
  },
  {
    id: technicianId(3, 6),
    dealership_id: DEALERSHIPS.hoChiMinh,
    name: 'Bui Quang Huy',
    skills: [SERVICE_TYPES.oilChange, SERVICE_TYPES.diagnostics, SERVICE_TYPES.annualService],
  },
];

export const CUSTOMERS = {
  harper: '50000000-0000-0000-0000-000000000001',
  osei: '50000000-0000-0000-0000-000000000002',
  kowalski: '50000000-0000-0000-0000-000000000003',
} as const;

export const VEHICLES = {
  harperGolf: '60000000-0000-0000-0000-000000000001',
  harperTransit: '60000000-0000-0000-0000-000000000002',
  oseiCorolla: '60000000-0000-0000-0000-000000000003',
  kowalskiOctavia: '60000000-0000-0000-0000-000000000004',
} as const;

const customerRows = [
  {
    id: CUSTOMERS.harper,
    name: 'Harper Ellis',
    email: 'harper.ellis@example.com',
    phone: '+44 20 7946 0011',
  },
  {
    id: CUSTOMERS.osei,
    name: 'Kwame Osei',
    email: 'kwame.osei@example.com',
    phone: '+44 20 7946 0022',
  },
  {
    id: CUSTOMERS.kowalski,
    name: 'Zofia Kowalski',
    email: 'zofia.kowalski@example.com',
    phone: '+84 28 3822 0033',
  },
];

const vehicleRows = [
  {
    id: VEHICLES.harperGolf,
    customer_id: CUSTOMERS.harper,
    vin: 'WVWZZZ1KZAW000111',
    make: 'Volkswagen',
    model: 'Golf',
  },
  {
    id: VEHICLES.harperTransit,
    customer_id: CUSTOMERS.harper,
    vin: 'WF0XXXTTFXAW000222',
    make: 'Ford',
    model: 'Transit',
  },
  {
    id: VEHICLES.oseiCorolla,
    customer_id: CUSTOMERS.osei,
    vin: 'JTDBR32E630000333',
    make: 'Toyota',
    model: 'Corolla',
  },
  {
    id: VEHICLES.kowalskiOctavia,
    customer_id: CUSTOMERS.kowalski,
    vin: 'TMBJF25L1E0000444',
    make: 'Skoda',
    model: 'Octavia',
  },
];

export async function seed(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Truncate rather than delete so re-seeding is a single statement and the
    // cascade order is the database's problem, not the script's.
    await trx.deleteFrom('appointments').execute();
    await trx.deleteFrom('technician_skills').execute();
    await trx.deleteFrom('technicians').execute();
    await trx.deleteFrom('service_bays').execute();
    await trx.deleteFrom('vehicles').execute();
    await trx.deleteFrom('customers').execute();
    await trx.deleteFrom('service_types').execute();
    await trx.deleteFrom('dealerships').execute();

    await trx.insertInto('service_types').values(serviceTypeRows).execute();
    await trx.insertInto('dealerships').values(dealershipRows).execute();
    await trx.insertInto('service_bays').values(bayRows).execute();
    await trx
      .insertInto('technicians')
      .values(
        technicianSeeds.map(({ id, dealership_id, name }) => ({ id, dealership_id, name })),
      )
      .execute();
    await trx
      .insertInto('technician_skills')
      .values(
        technicianSeeds.flatMap((technician) =>
          technician.skills.map((service_type_id) => ({
            technician_id: technician.id,
            service_type_id,
          })),
        ),
      )
      .execute();
    await trx.insertInto('customers').values(customerRows).execute();
    await trx.insertInto('vehicles').values(vehicleRows).execute();
  });
}
