/** Phase 3 routes: payments, collection, debts, receipts, drawer balance. Each one declares its access. */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  confirmPaymentSchema,
  debtSearchSchema,
  instalmentPreviewSchema,
  paymentSearchSchema,
  recordPaymentSchema,
  rejectPaymentSchema,
} from "@alyassir/shared";
import { RequirePermission } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";
import { FinanceService } from "./money/finance.service";
import { PaymentsService } from "./money/payments.service";

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ApiException("NOT_FOUND") });

@Controller("policies")
export class PolicyPaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(FinanceService) private readonly finance: FinanceService,
  ) {}

  /** Instalments shown before saving, computed by the server (SPEC 14.4). */
  @RequirePermission("policies.view")
  @Post("instalments-preview")
  @HttpCode(200)
  preview(@Body() body: unknown) {
    const input = parse(instalmentPreviewSchema, body);
    return this.payments.instalmentPreview(input.totalAmountCents, input.count, input.startDate, input.dates);
  }

  @RequirePermission("payments.view")
  @Get(":id/finance")
  financeOf(@Param("id", uuid) id: string) {
    return this.finance.finance(id);
  }

  @RequirePermission("payments.create")
  @Post(":id/payments")
  @HttpCode(200)
  pay(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.payments.record(ctx, user, id, parse(recordPaymentSchema, body));
  }
}

@Controller("payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @RequirePermission("payments.view")
  @Get()
  list(@Query() query: unknown) {
    return this.payments.list(parse(paymentSearchSchema, query));
  }

  @RequirePermission("payments.view")
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.payments.get(id);
  }

  /** Only the manager, or a supervisor with "confirm collection" (SPEC 14.1, 30). */
  @RequirePermission("sup.confirm_collection")
  @Post(":id/confirm")
  @HttpCode(200)
  confirm(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.payments.confirm(ctx, user, id, parse(confirmPaymentSchema, body).version);
  }

  @RequirePermission("sup.confirm_collection")
  @Post(":id/reject")
  @HttpCode(200)
  reject(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(rejectPaymentSchema, body);
    return this.payments.reject(ctx, user, id, input.version, input.reason);
  }
}

@Controller("debts")
export class DebtsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @RequirePermission("debts.view")
  @Get()
  list(@Query() query: unknown) {
    return this.payments.debts(parse(debtSearchSchema, query));
  }
}

@Controller("receipts")
export class ReceiptsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @RequirePermission("payments.view")
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.payments.receipt(id);
  }
}

@Controller("accounts")
export class AccountsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /** The drawer only; safe and bank are never shown to employees (SPEC 7.2). */
  @RequirePermission("drawer_balance.view")
  @Get("drawer")
  drawer() {
    return this.payments.drawer();
  }
}

export const PAYMENT_CONTROLLERS = [PolicyPaymentsController, PaymentsController, DebtsController, ReceiptsController, AccountsController];
