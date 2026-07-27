import type {
  BayCandidate,
  Clock,
  NewAppointment,
  SchedulingRepository,
  SchedulingUnitOfWork,
  TechnicianCandidate,
} from '../../src/application/scheduling/ports.js';
import { businessHours, timeOfDay } from '../../src/domain/scheduling/business-hours.js';
import type {
  Appointment,
  Customer,
  Dealership,
  ServiceType,
  Vehicle,
} from '../../src/domain/scheduling/entities.js';
import {
  appointmentId,
  customerId,
  dealershipId,
  serviceBayId,
  serviceTypeId,
  technicianId,
  vehicleId,
} from '../../src/domain/scheduling/ids.js';

export const LONDON = dealershipId('10000000-0000-0000-0000-000000000001');
export const OIL_CHANGE = serviceTypeId('20000000-0000-0000-0000-000000000001');
export const HARPER = customerId('50000000-0000-0000-0000-000000000001');
export const GOLF = vehicleId('60000000-0000-0000-0000-000000000001');

export const londonDealership: Dealership = {
  id: LONDON,
  name: 'Keyloop Motors London',
  timeZone: 'Europe/London',
  businessHours: businessHours(timeOfDay(8, 0), timeOfDay(18, 0)),
};

export const oilChange: ServiceType = {
  id: OIL_CHANGE,
  name: 'Oil Change',
  durationMinutes: 30,
};

export const harper: Customer = {
  id: HARPER,
  name: 'Harper Ellis',
  email: 'harper.ellis@example.com',
  phone: '+44 20 7946 0011',
};

export const golf: Vehicle = {
  id: GOLF,
  customerId: HARPER,
  vin: 'WVWZZZ1KZAW000111',
  make: 'Volkswagen',
  model: 'Golf',
};

export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: (): Date => new Date(instant.getTime()) };
}

export interface FakeRepositoryOptions {
  readonly dealership?: Dealership | undefined;
  readonly serviceType?: ServiceType | undefined;
  readonly customer?: Customer | undefined;
  readonly vehicle?: Vehicle | undefined;
  readonly bays?: readonly BayCandidate[];
  readonly technicians?: readonly TechnicianCandidate[];
  /** Lets a test simulate losing the race at insert time. */
  readonly onInsert?: ((appointment: NewAppointment) => Promise<Appointment>) | undefined;
  /** Seeds the store the cancellation use case reads from. */
  readonly appointments?: readonly Appointment[];
  /**
   * Simulates a concurrent cancellation: the conditional update matches nothing
   * even though the read saw a confirmed appointment.
   */
  readonly markCancelledReturnsNothing?: boolean;
}

export interface FakeRepository extends SchedulingRepository {
  readonly inserted: NewAppointment[];
  readonly transactionCount: () => number;
}

export function fakeRepository(options: FakeRepositoryOptions = {}): FakeRepository {
  const inserted: NewAppointment[] = [];
  let transactions = 0;

  const dealership = 'dealership' in options ? options.dealership : londonDealership;
  const serviceType = 'serviceType' in options ? options.serviceType : oilChange;
  const customer = 'customer' in options ? options.customer : harper;
  const vehicle = 'vehicle' in options ? options.vehicle : golf;

  const bays = options.bays ?? [{ id: serviceBayId('bay-1'), appointmentsOnDate: 0 }];
  const technicians = options.technicians ?? [
    { id: technicianId('tech-1'), appointmentsOnDate: 0 },
  ];

  const uow: SchedulingUnitOfWork = {
    findFreeBays: () => Promise.resolve(bays),
    findFreeQualifiedTechnicians: () => Promise.resolve(technicians),
    insertAppointment: async (appointment) => {
      if (options.onInsert !== undefined) {
        return options.onInsert(appointment);
      }
      inserted.push(appointment);
      return Promise.resolve({
        id: appointmentId('70000000-0000-0000-0000-000000000001'),
        customerId: appointment.customerId,
        vehicleId: appointment.vehicleId,
        dealershipId: appointment.dealershipId,
        serviceTypeId: appointment.serviceTypeId,
        technicianId: appointment.technicianId,
        serviceBayId: appointment.serviceBayId,
        timeRange: appointment.timeRange,
        status: 'confirmed',
      });
    },
  };

  const store = new Map<string, Appointment>(
    (options.appointments ?? []).map((appointment) => [appointment.id, appointment]),
  );

  return {
    inserted,
    transactionCount: () => transactions,
    findDealership: () => Promise.resolve(dealership),
    findServiceType: () => Promise.resolve(serviceType),
    findCustomer: () => Promise.resolve(customer),
    findVehicle: () => Promise.resolve(vehicle),
    findAppointment: (id) => Promise.resolve(store.get(id)),
    markCancelled: (id) => {
      const found = store.get(id);
      if (found === undefined || found.status !== 'confirmed') {
        return Promise.resolve(undefined);
      }
      if (options.markCancelledReturnsNothing === true) {
        // The concurrent-cancellation case: the row is already cancelled by the
        // time the update runs, so it matches nothing but the end state is right.
        store.set(id, { ...found, status: 'cancelled' });
        return Promise.resolve(undefined);
      }
      const cancelled: Appointment = { ...found, status: 'cancelled' };
      store.set(id, cancelled);
      return Promise.resolve(cancelled);
    },
    withTransaction: async (work) => {
      transactions += 1;
      return work(uow);
    },
  };
}
