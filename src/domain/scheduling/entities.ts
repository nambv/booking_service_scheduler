import type { BusinessHours } from './business-hours.js';
import type {
  AppointmentId,
  CustomerId,
  DealershipId,
  ServiceBayId,
  ServiceTypeId,
  TechnicianId,
  VehicleId,
} from './ids.js';
import type { TimeRange } from './time-range.js';

export interface Dealership {
  readonly id: DealershipId;
  readonly name: string;
  /** IANA zone, e.g. `Europe/London`. Business hours are read against this clock. */
  readonly timeZone: string;
  readonly businessHours: BusinessHours;
}

export interface ServiceType {
  readonly id: ServiceTypeId;
  readonly name: string;
  /** Fixed per service type and never client-supplied (assumptions A-003). */
  readonly durationMinutes: number;
}

export interface ServiceBay {
  readonly id: ServiceBayId;
  readonly dealershipId: DealershipId;
  readonly name: string;
}

export interface Technician {
  readonly id: TechnicianId;
  readonly dealershipId: DealershipId;
  readonly name: string;
  /** Qualification is a plain set membership test (assumptions A-009). */
  readonly skills: ReadonlySet<ServiceTypeId>;
}

export interface Customer {
  readonly id: CustomerId;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}

export interface Vehicle {
  readonly id: VehicleId;
  readonly customerId: CustomerId;
  readonly vin: string;
  readonly make: string;
  readonly model: string;
}

export type AppointmentStatus = 'confirmed' | 'cancelled';

export interface Appointment {
  readonly id: AppointmentId;
  readonly customerId: CustomerId;
  readonly vehicleId: VehicleId;
  readonly dealershipId: DealershipId;
  readonly serviceTypeId: ServiceTypeId;
  readonly technicianId: TechnicianId;
  readonly serviceBayId: ServiceBayId;
  readonly timeRange: TimeRange;
  readonly status: AppointmentStatus;
}
