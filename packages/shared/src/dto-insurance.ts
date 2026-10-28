/** Shapes returned by the API for Phase 2 (amounts in integer cents, dates "YYYY-MM-DD"). */
import type { ClientKind, Fuel, IdType, PlateType, Residency, ValidityStatus } from "./insurance";

export interface InsurerDto {
  id: string;
  name: string;
  archived: boolean;
  version: number;
}

export interface InsuranceTypeDto {
  id: string;
  insurerId: string;
  insurerName: string;
  /** One name in Latin letters, the same in both languages. */
  name: string;
  requiresVehicle: boolean;
  supportsFleet: boolean;
  archived: boolean;
  version: number;
}

export interface CoverageDurationDto {
  id: string;
  months: number;
  archived: boolean;
  version: number;
}

export interface OperationTypeDto {
  code: string;
  nameAr: string;
  nameFr: string;
  isSystem: boolean;
  archived: boolean;
  version: number;
}

export interface InsuranceCatalogDto {
  insurers: InsurerDto[];
  types: InsuranceTypeDto[];
  durations: CoverageDurationDto[];
  operationTypes: OperationTypeDto[];
  certificateFeeCents: number;
}

export interface ClientDto {
  id: string;
  kind: ClientKind;
  fullName: string;
  companyName: string | null;
  idType: IdType;
  idNumber: string;
  residency: Residency | null;
  phone: string;
  archived: boolean;
  version: number;
  createdAt: string;
  /** Number of policies active today. */
  activePolicies: number;
}

export interface PlateHistoryDto {
  plateType: PlateType;
  plate: string;
  newPlate: string;
  changedAt: string;
  changedByName: string | null;
  reason: string | null;
}

export interface VehicleDto {
  id: string;
  clientId: string;
  plateType: PlateType;
  plate: string;
  fiscalPower: number;
  fuel: Fuel;
  brand: string;
  archived: boolean;
  version: number;
  /** The policy covering this vehicle today, if any. */
  activePolicyId: string | null;
  activePolicyNumber: string | null;
  plateHistory: PlateHistoryDto[];
}

export interface PolicySummaryDto {
  id: string;
  policyNumber: string;
  insurerName: string;
  typeName: string;
  clientId: string;
  clientName: string;
  startDate: string;
  endDate: string;
  validity: ValidityStatus;
  isFleet: boolean;
  plates: string[];
  totalAmountCents: number;
}

export interface CoveredVehicleDto {
  vehicleId: string;
  plate: string;
  brand: string;
  certificateNumber: string;
  fromDate: string;
  toDate: string | null;
}

export interface PeriodDto {
  id: string;
  seq: number;
  startDate: string;
  endDate: string;
  months: number | null;
  totalAmountCents: number;
  validity: ValidityStatus;
  operation: "new_issue" | "renewal" | "policy_change";
  createdAt: string;
  createdByName: string | null;
  vehicles: CoveredVehicleDto[];
}

export interface OperationDto {
  id: string;
  type: string;
  nameAr: string;
  nameFr: string;
  date: string;
  userName: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  priceDifferenceCents: number | null;
  feeCents: number | null;
  /** Positive: the client pays; negative: the client receives. Settled in Phase 3. */
  netCents: number | null;
  settlementStatus: "none" | "pending" | "settled";
  paperReceiptNo: string | null;
  createdAt: string;
}

/** What may be done today, decided by the server (the screen only shows it). */
export interface PolicyActionsDto {
  /** "renewal": same number; "policy_change": from E+2, new number; "none": annulled/cancelled. */
  renewalMode: "renewal" | "policy_change" | "none";
  /** Default start of the next period (the day after the end). */
  nextStartDate: string;
  /** Earliest start accepted for a renewal (the previous end date). */
  earliestStartDate: string;
  /** Last day a renewal keeps the same number (E+1). */
  renewalLastDay: string;
  activeToday: boolean;
  /** A renewal that has not started yet blocks vehicle changes until it starts. */
  hasFuturePeriod: boolean;
  /** The total amount is locked 48 hours after the period was created. */
  amountLocked: boolean;
  amountLockedAt: string;
  /** Last day of annulment (first 15 days), null when it no longer applies. */
  annulUntil: string | null;
  alreadyReplaced: boolean;
}

export interface PolicyDto extends PolicySummaryDto {
  version: number;
  insurerId: string;
  insuranceTypeId: string;
  requiresVehicle: boolean;
  supportsFleet: boolean;
  fleet: { id: string; name: string } | null;
  replaces: { id: string; policyNumber: string } | null;
  replacedBy: { id: string; policyNumber: string } | null;
  currentPeriodId: string;
  /** Vehicles covered by the latest period, with their certificate. */
  vehicles: CoveredVehicleDto[];
  periods: PeriodDto[];
  operations: OperationDto[];
  actions: PolicyActionsDto;
  today: string;
}

export interface ClientFileDto {
  client: ClientDto;
  vehicles: VehicleDto[];
  policies: PolicySummaryDto[];
}

export interface DatesPreviewDto {
  startDate: string;
  endDate: string;
}

export interface AmountsPreviewDto {
  differenceCents: number;
  feeCents: number;
  /** difference + fee: positive the client pays, negative the client receives. */
  netCents: number;
  direction: "increase" | "same" | "decrease";
}

/** Returned when a permission is missing on a record: the user may send an edit request. */
export interface RequestableDetails {
  requestable: true;
  entityType: string;
  entityId: string;
  operation: string;
}
