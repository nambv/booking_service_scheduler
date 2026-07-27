import type { AvailabilityResult } from '../../application/scheduling/check-availability.js';
import type { UnavailableReason } from '../../application/scheduling/check-availability.js';
import type { Appointment, AppointmentStatus } from '../../domain/scheduling/entities.js';

/**
 * Domain objects never cross the wire directly. These functions are the one
 * place the API's JSON shape is defined, so the domain can evolve without
 * silently changing the contract.
 *
 * The return types are deliberately exact rather than `string` — the route
 * response schemas are enforced by the Zod type provider, so a widened type here
 * becomes a compile error instead of a runtime serialisation failure.
 */

export interface AppointmentResource {
  readonly id: string;
  readonly customerId: string;
  readonly vehicleId: string;
  readonly dealershipId: string;
  readonly serviceTypeId: string;
  readonly technicianId: string;
  readonly serviceBayId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly status: AppointmentStatus;
}

export function serialiseAppointment(appointment: Appointment): AppointmentResource {
  return {
    id: appointment.id,
    customerId: appointment.customerId,
    vehicleId: appointment.vehicleId,
    dealershipId: appointment.dealershipId,
    serviceTypeId: appointment.serviceTypeId,
    technicianId: appointment.technicianId,
    serviceBayId: appointment.serviceBayId,
    startTime: appointment.timeRange.start.toISOString(),
    endTime: appointment.timeRange.end.toISOString(),
    status: appointment.status,
  };
}

export interface AvailabilityResponse {
  readonly available: boolean;
  readonly startTime: string;
  readonly endTime: string;
  readonly freeBays: number;
  readonly freeQualifiedTechnicians: number;
  readonly reason: UnavailableReason | null;
}

export function serialiseAvailability(result: AvailabilityResult): AvailabilityResponse {
  return {
    available: result.available,
    startTime: result.requested.start.toISOString(),
    endTime: result.requested.end.toISOString(),
    freeBays: result.freeBays,
    freeQualifiedTechnicians: result.freeQualifiedTechnicians,
    reason: result.reason,
  };
}
