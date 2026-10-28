/** Shapes returned by the API. */
import type { Language } from "./constants";
import type { PermissionCode, Role } from "./permissions";

export interface MeDto {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isSupervisor: boolean;
  /** null: the user has not chosen yet (first login asks). */
  language: Language | null;
  /** Effective permissions. The manager has all of them. */
  permissions: PermissionCode[];
  /** Safe and bank are invisible to employees unless a supervisor power needs them. */
  canSeeSafeAndBank: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  serverVersion: string;
  me: MeDto;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isSupervisor: boolean;
  isActive: boolean;
  language: Language | null;
  lockedUntil: string | null;
  permissions: PermissionCode[];
  version: number;
  createdAt: string;
}

export interface DirectoryUserDto {
  id: string;
  displayName: string;
  role: Role;
}

export interface AgencySettingsDto {
  nameAr: string;
  nameFr: string;
  address: string;
  phone: string;
  licenseNumber: string;
  idleTimeoutMinutes: number;
  hasLogo: boolean;
  backupDir: string;
  version: number;
}

export interface AuditEntryDto {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  device: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RecipientDto {
  userId: string;
  displayName: string;
  kind: "to" | "cc";
  readAt: string | null;
}

export interface MessageDto {
  id: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  createdAt: string;
  recipients: RecipientDto[];
}

export interface ThreadSummaryDto {
  id: string;
  subject: string;
  kind: "user" | "system";
  editRequestId: string | null;
  lastMessageAt: string;
  lastSenderName: string | null;
  unread: number;
  participants: string[];
}

export interface ThreadDto {
  id: string;
  subject: string;
  kind: "user" | "system";
  editRequestId: string | null;
  messages: MessageDto[];
}

export type EditRequestStatus = "pending" | "approved" | "rejected" | "used" | "expired";

export interface EditRequestDto {
  id: string;
  requesterId: string;
  requesterName: string;
  entityType: string;
  entityId: string;
  operation: string;
  note: string;
  status: EditRequestStatus;
  decisionReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  createdAt: string;
  threadId: string | null;
}

/** Realtime "something changed" signal; the client refetches (SPEC 3.2). */
export type ChangeTopic = "users" | "me" | "settings" | "messages" | "edit_requests" | "audit" | "insurance" | "clients" | "vehicles" | "policies" | "payments" | "drawer" | "expenses" | "accounts" | "claims" | "contacts";
export interface ChangeSignal {
  topic: ChangeTopic;
}

export interface SystemInfoDto {
  app: "alyassir";
  serverVersion: string;
  minClientVersion: string;
}
