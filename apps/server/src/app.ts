import "reflect-metadata";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Server as HttpServer } from "node:http";
import { AuditService } from "./audit/audit.service";
import { AuthService } from "./auth/auth.service";
import { LOGIN_RATE_LIMIT, LoginThrottle } from "./auth/login-throttle";
import { AccessGuard } from "./common/access.guard";
import { AccessService } from "./common/access.service";
import { ClientsService } from "./clients/clients.service";
import { CatalogService } from "./insurance/catalog.service";
import { PoliciesService } from "./policies/policies.service";
import { PolicyOperationsService } from "./policies/policy-operations.service";
import { PolicyReader } from "./policies/policy-reader";
import { VehiclesService } from "./vehicles/vehicles.service";
import { FinanceService } from "./money/finance.service";
import { JobsService } from "./money/jobs.service";
import { PaymentsService } from "./money/payments.service";
import { AccountsService } from "./cash/accounts.service";
import { DrawerService } from "./cash/drawer.service";
import { ExpensesService } from "./cash/expenses.service";
import { ClaimsService } from "./followup/claims.service";
import { ContactsService } from "./followup/contacts.service";
import { RemindersService } from "./followup/reminders.service";
import { DashboardService } from "./reports/dashboard.service";
import { ReportsService } from "./reports/reports.service";
import { BACKUP_CONFIG, BackupsService } from "./backups/backups.service";
import { BackupJobs } from "./backups/backup-jobs";
import { MaintenanceGuard } from "./backups/maintenance.guard";
import { UsbService } from "./backups/usb.service";
import { HistoricalGuard } from "./historical/historical.guard";
import { HistoricalService } from "./historical/historical.service";
import { runInRequest } from "./common/clock";
import { ErrorFilter } from "./common/error.filter";
import type { ServerConfig } from "./config";
import { CONTROLLERS } from "./controllers";
import { DatabaseService } from "./database.service";
import { EditRequestsService } from "./edit-requests/edit-requests.service";
import { MessagesService } from "./messages/messages.service";
import { RealtimeService } from "./realtime/realtime.service";
import { SettingsService } from "./settings/settings.service";
import { SystemService } from "./system/system.service";
import { UsersService } from "./users/users.service";

@Module({})
export class AppModule {
  static register(config: ServerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [JwtModule.register({ secret: config.jwtSecret, signOptions: { algorithm: "HS256" }, verifyOptions: { algorithms: ["HS256"] } })],
      controllers: CONTROLLERS,
      providers: [
        { provide: DatabaseService, useFactory: () => new DatabaseService(config.databaseUrl) },
        { provide: LOGIN_RATE_LIMIT, useValue: config.loginRateLimitPerMinute ?? 20 },
        { provide: BACKUP_CONFIG, useValue: config.backup ?? null },
        // The maintenance guard (restore, overdue USB copy) runs before the access guard.
        { provide: APP_GUARD, useClass: MaintenanceGuard },
        { provide: APP_GUARD, useClass: AccessGuard },
        // After the access guard (the user is known): the operation date of the request (SPEC 22).
        { provide: APP_GUARD, useClass: HistoricalGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        AuditService,
        AuthService,
        LoginThrottle,
        RealtimeService,
        SettingsService,
        SystemService,
        UsersService,
        MessagesService,
        EditRequestsService,
        AccessService,
        CatalogService,
        ClientsService,
        VehiclesService,
        PolicyReader,
        PoliciesService,
        PolicyOperationsService,
        FinanceService,
        PaymentsService,
        JobsService,
        DrawerService,
        ExpensesService,
        AccountsService,
        ClaimsService,
        ContactsService,
        RemindersService,
        ReportsService,
        DashboardService,
        BackupsService,
        UsbService,
        BackupJobs,
        HistoricalService,
      ],
    };
  }
}

export async function createApp(config: ServerConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    ...(config.tls ? { https: { pfx: config.tls.pfx, passphrase: config.tls.passphrase } } : {}),
    // Logo upload (base64, at most 500 KB) is the largest request.
    bodyLimit: 1_048_576,
    trustProxy: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), adapter, {
    logger: ["error", "warn", "log"],
  });
  // Security headers and a general request limit (SPEC 4.15).
  await app.register(helmet as never, { contentSecurityPolicy: false });
  await app.register(rateLimit as never, { max: 1200, timeWindow: "1 minute" });
  // Browser tests only (the desktop app does not use CORS). All methods the API uses.
  if (config.testCorsOrigin) app.enableCors({ origin: config.testCorsOrigin, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  // One store per request for its operation date (historical entry, SPEC 22), after the body is read.
  app.getHttpAdapter().getInstance().addHook("preHandler", (_req: unknown, _reply: unknown, done: () => void) => runInRequest(done));
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();

  const realtime = app.get(RealtimeService);
  const auth = app.get(AuthService);
  realtime.attach(app.getHttpServer() as HttpServer, (token) => auth.socketUserId(token), config.testCorsOrigin);
  return app;
}
