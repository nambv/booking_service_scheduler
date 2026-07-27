declare const brand: unique symbol;

type Brand<T, K extends string> = T & { readonly [brand]: K };

export type DealershipId = Brand<string, 'DealershipId'>;
export type ServiceBayId = Brand<string, 'ServiceBayId'>;
export type TechnicianId = Brand<string, 'TechnicianId'>;
export type ServiceTypeId = Brand<string, 'ServiceTypeId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type VehicleId = Brand<string, 'VehicleId'>;
export type AppointmentId = Brand<string, 'AppointmentId'>;

// Every resource in this system is identified by a UUID string, which means the
// compiler would happily accept a technician id where a bay id belongs. Branding
// makes that a type error instead of a runtime mystery.
export function dealershipId(value: string): DealershipId {
  return value as DealershipId;
}

export function serviceBayId(value: string): ServiceBayId {
  return value as ServiceBayId;
}

export function technicianId(value: string): TechnicianId {
  return value as TechnicianId;
}

export function serviceTypeId(value: string): ServiceTypeId {
  return value as ServiceTypeId;
}

export function customerId(value: string): CustomerId {
  return value as CustomerId;
}

export function vehicleId(value: string): VehicleId {
  return value as VehicleId;
}

export function appointmentId(value: string): AppointmentId {
  return value as AppointmentId;
}
