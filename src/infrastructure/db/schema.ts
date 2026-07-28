import type { Generated } from 'kysely';

/**
 * The shape Kysely generates queries against. Column names are snake_case
 * because that is what the database actually holds; translation to the domain's
 * camelCase happens in the repository, which is the only place that should know
 * both vocabularies.
 */
export interface Database {
  dealerships: DealershipTable;
  service_types: ServiceTypeTable;
  service_bays: ServiceBayTable;
  technicians: TechnicianTable;
  technician_skills: TechnicianSkillTable;
  customers: CustomerTable;
  vehicles: VehicleTable;
  appointments: AppointmentTable;
}

export interface DealershipTable {
  id: Generated<string>;
  name: string;
  timezone: string;
  /** Postgres `time` renders as `HH:MM:SS`. */
  opens_at: string;
  closes_at: string;
  created_at: Generated<Date>;
}

export interface ServiceTypeTable {
  id: Generated<string>;
  name: string;
  duration_minutes: number;
}

export interface ServiceBayTable {
  id: Generated<string>;
  dealership_id: string;
  name: string;
}

export interface TechnicianTable {
  id: Generated<string>;
  dealership_id: string;
  name: string;
}

export interface TechnicianSkillTable {
  technician_id: string;
  service_type_id: string;
}

export interface CustomerTable {
  id: Generated<string>;
  name: string;
  email: string;
  phone: string;
}

export interface VehicleTable {
  id: Generated<string>;
  customer_id: string;
  vin: string;
  make: string;
  model: string;
}

export interface AppointmentTable {
  id: Generated<string>;
  customer_id: string;
  vehicle_id: string;
  dealership_id: string;
  service_type_id: string;
  technician_id: string;
  service_bay_id: string;
  /** `tstzrange`, always half-open: `["2026-03-02 09:00+00","2026-03-02 10:00+00")`. */
  time_range: string;
  /** Derived by the database from time_range; never written by the application. */
  duration_minutes: Generated<number>;
  status: Generated<'confirmed' | 'cancelled'>;
  created_at: Generated<Date>;
}
