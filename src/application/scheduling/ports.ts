import type {
  Appointment,
  Customer,
  Dealership,
  ServiceType,
  Vehicle,
} from '../../domain/scheduling/entities.js';
import type {
  AppointmentId,
  CustomerId,
  DealershipId,
  ServiceBayId,
  ServiceTypeId,
  TechnicianId,
  VehicleId,
} from '../../domain/scheduling/ids.js';
import type { TimeRange } from '../../domain/scheduling/time-range.js';

/** Injected so "is this booking in the past?" is testable without waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: (): Date => new Date(),
};

/**
 * A resource that is free for the requested range, carried together with how
 * loaded it already is that day so the domain can apply its selection policy
 * (assumptions A-014) without a second round trip.
 */
export interface BayCandidate {
  readonly id: ServiceBayId;
  readonly appointmentsOnDate: number;
}

export interface TechnicianCandidate {
  readonly id: TechnicianId;
  readonly appointmentsOnDate: number;
}

export interface NewAppointment {
  readonly customerId: CustomerId;
  readonly vehicleId: VehicleId;
  readonly dealershipId: DealershipId;
  readonly serviceTypeId: ServiceTypeId;
  readonly technicianId: TechnicianId;
  readonly serviceBayId: ServiceBayId;
  readonly timeRange: TimeRange;
}

/**
 * The work that must happen inside one transaction. Splitting it out from the
 * repository is what stops a caller from running the availability query and the
 * insert in two separate transactions, which is the shape of the bug this whole
 * project is about.
 */
export interface SchedulingUnitOfWork {
  findFreeBays(dealership: Dealership, range: TimeRange): Promise<readonly BayCandidate[]>;

  findFreeQualifiedTechnicians(
    dealership: Dealership,
    serviceType: ServiceTypeId,
    range: TimeRange,
  ): Promise<readonly TechnicianCandidate[]>;

  /**
   * Implementations must translate a Postgres exclusion-constraint violation
   * (SQLSTATE 23P01) into `SlotAlreadyTaken`, and must not retry.
   */
  insertAppointment(appointment: NewAppointment): Promise<Appointment>;
}

export interface SchedulingRepository {
  findDealership(id: DealershipId): Promise<Dealership | undefined>;
  findServiceType(id: ServiceTypeId): Promise<ServiceType | undefined>;
  findCustomer(id: CustomerId): Promise<Customer | undefined>;
  findVehicle(id: VehicleId): Promise<Vehicle | undefined>;
  findAppointment(id: AppointmentId): Promise<Appointment | undefined>;

  /**
   * Flips a confirmed appointment to cancelled and returns it.
   *
   * Resolves to `undefined` when no *confirmed* appointment with that id exists —
   * either it is gone or a concurrent caller cancelled it first. The distinction
   * is left to the use case, which re-reads; making the update conditional is
   * what keeps two simultaneous cancellations from both claiming to be the one
   * that did it.
   */
  markCancelled(id: AppointmentId): Promise<Appointment | undefined>;

  withTransaction<T>(work: (uow: SchedulingUnitOfWork) => Promise<T>): Promise<T>;
}
