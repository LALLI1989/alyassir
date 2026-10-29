/** Phase 6A routes: dashboard and reports. Each one declares its access. */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { REPORT_CODES, dashboardQuerySchema, reportRequestSchema, type ReportCode } from "@alyassir/shared";
import { Authenticated, RequirePermission } from "./common/access";
import { CurrentUser, type AuthUser } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";
import { DashboardService } from "./reports/dashboard.service";
import { ReportsService } from "./reports/reports.service";

function reportCode(code: string): ReportCode {
  if (!(REPORT_CODES as readonly string[]).includes(code)) throw new ApiException("NOT_FOUND");
  return code as ReportCode;
}

@Controller("dashboard")
class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  /** Everyone: each card is filled only for who may see it. */
  @Authenticated()
  @Get()
  get(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.dashboard.get(user, parse(dashboardQuerySchema, query).period);
  }
}

@Controller("reports")
class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @RequirePermission("reports.view")
  @Get()
  index(@CurrentUser() user: AuthUser) {
    return this.reports.index(user);
  }

  /** Each report also needs the permission of its module (checked by the service). */
  @RequirePermission("reports.view")
  @HttpCode(200)
  @Post(":code")
  run(@Param("code") code: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.reports.run(user, reportCode(code), parse(reportRequestSchema, body));
  }

  /** Saving a report as a file needs "export" (PDF is printed from the screen, under the same rule). */
  @RequirePermission("export")
  @HttpCode(200)
  @Post(":code/excel")
  excel(@Param("code") code: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.reports.excel(user, reportCode(code), parse(reportRequestSchema, body));
  }
}

export const REPORT_CONTROLLERS = [DashboardController, ReportsController];
