import { type Kysely, sql } from 'kysely';

import type {
  BayCandidate,
  NewAppointment,
  SchedulingRepository,
  SchedulingUnitOfWork,
  TechnicianCandidate,
} from '../../application/scheduling/ports.js';
import { businessHours, parseTimeOfDay } from '../../domain/scheduling/business-hours.js';
import type {
  Appointment,
  Customer,
  Dealership,
  ServiceType,
  Vehicle,
} from '../../domain/scheduling/entities.js';
import { BookingContended, SlotAlreadyTaken } from '../../domain/scheduling/errors.js';
import {
  appointmentId,
  customerId,
  dealershipId,
  serviceBayId,
  serviceTypeId,
  technicianId,
  vehicleId,
} from '../../domain/scheduling/ids.js';
import type {
  AppointmentId,
  CustomerId,
  DealershipId,
  ServiceTypeId,
  VehicleId,
} from '../../domain/scheduling/ids.js';
import { timeRange } from '../../domain/scheduling/time-range.js';
import type { TimeRange } from '../../domain/scheduling/time-range.js';
import { withSpan } from '../observability/tracing.js';
import type { Database } from './schema.js';

const EXCLUSION_VIOLATION = '23P01';
const DEADLOCK_DETECTED = '40P01';

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function postgresError(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, constraint } = error as PostgresErrorShape;
  if (typeof code !== 'string') {
    return undefined;
  }
  return { code, constraint: typeof constraint === 'string' ? constraint : '' };
}

export interface RepositoryObservers {
  /** Called with the wall-clock seconds each candidate availability query took. */
  readonly onAvailabilityQuery?: (seconds: number) => void;
}

export function createSchedulingRepository(
  db: Kysely<Database>,
  observers: RepositoryObservers = {},
): SchedulingRepository {
  return {
    async findDealership(id: DealershipId): Promise<Dealership | undefined> {
      const row = await db
        .selectFrom('dealerships')
        .select(['id', 'name', 'timezone', 'opens_at', 'closes_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) {
        return undefined;
      }
      return {
        id: dealershipId(row.id),
        name: row.name,
        timeZone: row.timezone,
        businessHours: businessHours(parseTimeOfDay(row.opens_at), parseTimeOfDay(row.closes_at)),
      };
    },

    async findServiceType(id: ServiceTypeId): Promise<ServiceType | undefined> {
      const row = await db
        .selectFrom('service_types')
        .select(['id', 'name', 'duration_minutes'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { id: serviceTypeId(row.id), name: row.name, durationMinutes: row.duration_minutes };
    },

    async findCustomer(id: CustomerId): Promise<Customer | undefined> {
      const row = await db
        .selectFrom('customers')
        .select(['id', 'name', 'email', 'phone'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { id: customerId(row.id), name: row.name, email: row.email, phone: row.phone };
    },

    async findVehicle(id: VehicleId): Promise<Vehicle | undefined> {
      const row = await db
        .selectFrom('vehicles')
        .select(['id', 'customer_id', 'vin', 'make', 'model'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            id: vehicleId(row.id),
            customerId: customerId(row.customer_id),
            vin: row.vin,
            make: row.make,
            model: row.model,
          };
    },

    async findAppointment(id: AppointmentId): Promise<Appointment | undefined> {
      const { rows } = await sql<AppointmentRow>`
        SELECT id, customer_id, vehicle_id, dealership_id, service_type_id,
               technician_id, service_bay_id,
               lower(time_range) AS starts_at, upper(time_range) AS ends_at, status
        FROM appointments
        WHERE id = ${id}
      `.execute(db);
      const row = rows[0];
      return row === undefined ? undefined : toAppointment(row);
    },

    async markCancelled(id: AppointmentId): Promise<Appointment | undefined> {
      // `AND status = 'confirmed'` makes the update conditional, so exactly one of
      // two simultaneous cancellations gets a row back. No lock is needed: the
      // row-level write lock Postgres already takes is the serialisation point.
      const { rows } = await sql<AppointmentRow>`
        UPDATE appointments
           SET status = 'cancelled'
         WHERE id = ${id}
           AND status = 'confirmed'
        RETURNING id, customer_id, vehicle_id, dealership_id, service_type_id,
                  technician_id, service_bay_id,
                  lower(time_range) AS starts_at, upper(time_range) AS ends_at, status
      `.execute(db);
      const row = rows[0];
      return row === undefined ? undefined : toAppointment(row);
    },

    // READ COMMITTED, the Postgres default, is deliberate. Nothing here relies on
    // the read being repeatable — the exclusion constraint on insert is what makes
    // the outcome correct, so a stronger isolation level would buy contention
    // without buying safety.
    withTransaction<T>(work: (uow: SchedulingUnitOfWork) => Promise<T>): Promise<T> {
      return db.transaction().execute((trx) => work(createUnitOfWork(trx, observers)));
    },
  };
}

/** Wraps a candidate query in a trace span and reports its duration in one step. */
function instrumentedQuery<T>(
  span: string,
  observer: ((seconds: number) => void) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return withSpan(span, async () => {
    if (observer === undefined) {
      return work();
    }
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      observer((performance.now() - startedAt) / 1000);
    }
  });
}

function createUnitOfWork(
  trx: Kysely<Database>,
  observers: RepositoryObservers,
): SchedulingUnitOfWork {
  return {
    findFreeBays(dealership: Dealership, range: TimeRange): Promise<readonly BayCandidate[]> {
      return instrumentedQuery('availability.free_bays', observers.onAvailabilityQuery, async () => {
        const { rows } = await sql<{ id: string; appointments_on_date: number }>`
        SELECT b.id,
               count(a.id)::int AS appointments_on_date
        FROM service_bays b
        LEFT JOIN appointments a
               ON a.service_bay_id = b.id
              AND a.status = 'confirmed'
              AND (lower(a.time_range) AT TIME ZONE ${dealership.timeZone})::date
                = (${range.start}::timestamptz AT TIME ZONE ${dealership.timeZone})::date
        WHERE b.dealership_id = ${dealership.id}
          AND NOT EXISTS (
            SELECT 1
            FROM appointments busy
            WHERE busy.service_bay_id = b.id
              AND busy.status = 'confirmed'
              AND busy.time_range && tstzrange(${range.start}, ${range.end}, '[)')
          )
        GROUP BY b.id
        ORDER BY appointments_on_date, b.id
      `.execute(trx);

        return rows.map((row) => ({
          id: serviceBayId(row.id),
          appointmentsOnDate: row.appointments_on_date,
        }));
      });
    },

    findFreeQualifiedTechnicians(
      dealership: Dealership,
      serviceType: ServiceTypeId,
      range: TimeRange,
    ): Promise<readonly TechnicianCandidate[]> {
      return instrumentedQuery(
        'availability.free_technicians',
        observers.onAvailabilityQuery,
        async () => {
          const { rows } = await sql<{ id: string; appointments_on_date: number }>`
        SELECT t.id,
               count(a.id)::int AS appointments_on_date
        FROM technicians t
        -- Qualification is an inner join, so an unskilled technician can never
        -- appear as a candidate no matter how free their calendar is.
        JOIN technician_skills ts
          ON ts.technician_id = t.id
         AND ts.service_type_id = ${serviceType}
        LEFT JOIN appointments a
               ON a.technician_id = t.id
              AND a.status = 'confirmed'
              AND (lower(a.time_range) AT TIME ZONE ${dealership.timeZone})::date
                = (${range.start}::timestamptz AT TIME ZONE ${dealership.timeZone})::date
        WHERE t.dealership_id = ${dealership.id}
          AND NOT EXISTS (
            SELECT 1
            FROM appointments busy
            WHERE busy.technician_id = t.id
              AND busy.status = 'confirmed'
              AND busy.time_range && tstzrange(${range.start}, ${range.end}, '[)')
          )
        GROUP BY t.id
        ORDER BY appointments_on_date, t.id
      `.execute(trx);

          return rows.map((row) => ({
            id: technicianId(row.id),
            appointmentsOnDate: row.appointments_on_date,
          }));
        },
      );
    },

    insertAppointment(appointment: NewAppointment): Promise<Appointment> {
      return withSpan('appointment.insert', async () => {
        try {
        const { rows } = await sql<AppointmentRow>`
          INSERT INTO appointments
            (customer_id, vehicle_id, dealership_id, service_type_id,
             technician_id, service_bay_id, time_range, status)
          VALUES
            (${appointment.customerId}, ${appointment.vehicleId}, ${appointment.dealershipId},
             ${appointment.serviceTypeId}, ${appointment.technicianId}, ${appointment.serviceBayId},
             tstzrange(${appointment.timeRange.start}, ${appointment.timeRange.end}, '[)'),
             'confirmed')
          RETURNING id, customer_id, vehicle_id, dealership_id, service_type_id,
                    technician_id, service_bay_id,
                    lower(time_range) AS starts_at, upper(time_range) AS ends_at, status
        `.execute(trx);

        const row = rows[0];
        if (row === undefined) {
          throw new Error('INSERT ... RETURNING produced no row');
        }
        return toAppointment(row);
      } catch (error) {
        const pg = postgresError(error);
        if (pg?.code === EXCLUSION_VIOLATION) {
          // Someone committed an overlapping booking first. Which resource is
          // named by the violated constraint, so the caller learns what was
          // contended (A-015).
          throw new SlotAlreadyTaken(
            pg.constraint === 'no_bay_overlap' ? 'service_bay' : 'technician',
          );
        }
        if (pg?.code === DEADLOCK_DETECTED) {
          // Transient: the caller's transaction was chosen as the deadlock
          // victim. Retried on a fresh transaction by the use case, not surfaced.
          throw new BookingContended('Booking deadlocked under contention');
        }
        throw error;
      }
      });
    },
  };
}

interface AppointmentRow {
  id: string;
  customer_id: string;
  vehicle_id: string;
  dealership_id: string;
  service_type_id: string;
  technician_id: string;
  service_bay_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: appointmentId(row.id),
    customerId: customerId(row.customer_id),
    vehicleId: vehicleId(row.vehicle_id),
    dealershipId: dealershipId(row.dealership_id),
    serviceTypeId: serviceTypeId(row.service_type_id),
    technicianId: technicianId(row.technician_id),
    serviceBayId: serviceBayId(row.service_bay_id),
    timeRange: timeRange(row.starts_at, row.ends_at),
    status: row.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}
