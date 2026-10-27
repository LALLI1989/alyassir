import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { LOGO_MAX_BYTES, type AgencySettingsDto, type AgencySettingsInput } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

type Row = typeof schema.agencySettings.$inferSelect;

function toDto(row: Row): AgencySettingsDto {
  return {
    nameAr: row.nameAr,
    nameFr: row.nameFr,
    address: row.address,
    phone: row.phone,
    licenseNumber: row.licenseNumber,
    idleTimeoutMinutes: row.idleTimeoutMinutes,
    hasLogo: row.logo !== null,
    backupDir: row.backupDir,
    version: row.version,
  };
}

/** Detects the image type from its first bytes (never trust the file name). */
export function imageType(data: Buffer): "image/png" | "image/jpeg" | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

@Injectable()
export class SettingsService {
  private idleCache: { minutes: number; at: number } | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private async row(): Promise<Row> {
    const [row] = await this.database.db.select().from(schema.agencySettings).where(eq(schema.agencySettings.id, 1));
    if (!row) throw new ApiException("INTERNAL", { message: "agency settings missing" });
    return row;
  }

  async get(): Promise<AgencySettingsDto> {
    return toDto(await this.row());
  }

  /** Idle timeout, cached a few seconds: it is read on every request. */
  async idleTimeoutMinutes(): Promise<number> {
    const now = Date.now();
    if (this.idleCache && now - this.idleCache.at < 5000) return this.idleCache.minutes;
    const row = await this.row();
    this.idleCache = { minutes: row.idleTimeoutMinutes, at: now };
    return row.idleTimeoutMinutes;
  }

  async update(ctx: RequestContext, input: AgencySettingsInput): Promise<AgencySettingsDto> {
    const s = schema.agencySettings;
    const result = await this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s).where(eq(s.id, 1)).for("update");
      if (!before) throw new ApiException("NOT_FOUND");
      if (before.version !== input.version) throw new ApiException("VERSION_CONFLICT");
      const [after] = await tx
        .update(s)
        .set({
          nameAr: input.nameAr,
          nameFr: input.nameFr,
          address: input.address,
          phone: input.phone,
          licenseNumber: input.licenseNumber,
          idleTimeoutMinutes: input.idleTimeoutMinutes,
          version: before.version + 1,
          updatedAt: new Date(),
          updatedBy: ctx.user?.id ?? null,
        })
        .where(and(eq(s.id, 1), eq(s.version, input.version)))
        .returning();
      if (!after) throw new ApiException("VERSION_CONFLICT");
      await this.audit.record(tx, ctx, {
        action: "settings.update",
        entityType: "agency_settings",
        entityId: "1",
        before: toDto(before),
        after: toDto(after),
      });
      return after;
    });
    this.idleCache = null;
    this.realtime.notifyAll("settings");
    return toDto(result);
  }

  async getLogo(): Promise<{ type: string; dataBase64: string } | null> {
    const row = await this.row();
    if (!row.logo || !row.logoType) return null;
    return { type: row.logoType, dataBase64: row.logo.toString("base64") };
  }

  async setLogo(ctx: RequestContext, version: number, dataBase64: string | null): Promise<AgencySettingsDto> {
    let data: Buffer | null = null;
    let type: "image/png" | "image/jpeg" | null = null;
    if (dataBase64 !== null) {
      data = Buffer.from(dataBase64, "base64");
      if (data.length > LOGO_MAX_BYTES) throw new ApiException("LOGO_TOO_LARGE");
      type = imageType(data);
      if (!type) throw new ApiException("LOGO_BAD_TYPE");
    }
    const s = schema.agencySettings;
    const result = await this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s).where(eq(s.id, 1)).for("update");
      if (!before) throw new ApiException("NOT_FOUND");
      if (before.version !== version) throw new ApiException("VERSION_CONFLICT");
      const [after] = await tx
        .update(s)
        .set({ logo: data, logoType: type, version: before.version + 1, updatedAt: new Date(), updatedBy: ctx.user?.id ?? null })
        .where(eq(s.id, 1))
        .returning();
      if (!after) throw new ApiException("VERSION_CONFLICT");
      await this.audit.record(tx, ctx, {
        action: data ? "settings.logo_set" : "settings.logo_removed",
        entityType: "agency_settings",
        entityId: "1",
        after: data ? { type, bytes: data.length } : null,
      });
      return after;
    });
    this.realtime.notifyAll("settings");
    return toDto(result);
  }
}
