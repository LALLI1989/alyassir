/** Phase 4 routes: drawer session and closing, expenses, accounts. Each one declares its access. */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import {
  bankNegativeSchema,
  closeDrawerSchema,
  dayReviewSchema,
  expenseApproveSchema,
  expenseCancelSchema,
  expenseCreateSchema,
  expenseEditSchema,
  expenseRejectSchema,
  expenseSearchSchema,
  insurerPaymentSchema,
  joinDrawerSchema,
  listItemArchiveSchema,
  listItemSchema,
  movementSearchSchema,
  reverseSchema,
  transferSchema,
  withdrawalSchema,
} from "@alyassir/shared";
import { AccountsService } from "./cash/accounts.service";
import { DrawerService } from "./cash/drawer.service";
import { ExpensesService } from "./cash/expenses.service";
import { Authenticated, ManagerOnly, RequirePermission } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ApiException("NOT_FOUND") });
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(25) });

@Controller("drawer")
class DrawerController {
  constructor(@Inject(DrawerService) private readonly drawer: DrawerService) {}

  /** Checked in the service: whoever handles cash, or may see closings. */
  @Authenticated()
  @Get()
  state(@CurrentUser() user: AuthUser) {
    return this.drawer.state(user);
  }

  /** Checked in the service: payments, expenses or closing "create". */
  @Authenticated()
  @Post("receive")
  @HttpCode(200)
  receive(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.drawer.receive(ctx, user, parse(joinDrawerSchema, body));
  }

  /** Checked in the service: a member with "closing: create", or on behalf (manager, supervisor power). */
  @Authenticated()
  @Post("close")
  @HttpCode(200)
  close(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.drawer.close(ctx, user, parse(closeDrawerSchema, body));
  }

  @RequirePermission("closing.view")
  @Get("closings")
  closings(@Query() query: unknown) {
    const q = parse(pageSchema, query);
    return this.drawer.closings(q.page, q.pageSize);
  }

  @RequirePermission("closing.view")
  @Get("days")
  days() {
    return this.drawer.days();
  }

  @ManagerOnly()
  @Post("days/review")
  @HttpCode(200)
  review(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.drawer.review(ctx, user, parse(dayReviewSchema, body));
  }
}

@Controller("expenses")
class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly expenses: ExpensesService) {}

  @Authenticated()
  @Get("categories")
  categories() {
    return this.expenses.categories();
  }

  @ManagerOnly()
  @Post("categories")
  addCategory(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.expenses.addCategory(ctx, user, parse(listItemSchema, body).name);
  }

  @ManagerOnly()
  @Post("categories/:id/archive")
  @HttpCode(200)
  archiveCategory(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(listItemArchiveSchema, body);
    return this.expenses.archiveCategory(ctx, id, input.version, input.archived);
  }

  @RequirePermission("expenses.view")
  @Get()
  list(@Query() query: unknown) {
    return this.expenses.list(parse(expenseSearchSchema, query));
  }

  @RequirePermission("expenses.create")
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.expenses.create(ctx, user, parse(expenseCreateSchema, body));
  }

  @ManagerOnly()
  @Patch(":id")
  edit(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.expenses.edit(ctx, id, parse(expenseEditSchema, body));
  }

  @RequirePermission("sup.approve_expenses")
  @Post(":id/approve")
  @HttpCode(200)
  approve(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.expenses.approve(ctx, user, id, parse(expenseApproveSchema, body));
  }

  @RequirePermission("sup.approve_expenses")
  @Post(":id/reject")
  @HttpCode(200)
  reject(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.expenses.reject(ctx, user, id, parse(expenseRejectSchema, body));
  }

  @ManagerOnly()
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.expenses.cancel(ctx, user, id, parse(expenseCancelSchema, body));
  }
}

@Controller("accounts")
class CashAccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  /** Safe and bank: "not found" for anyone who may not see them (checked in the service). */
  @Authenticated()
  @Get()
  balances(@CurrentUser() user: AuthUser) {
    return this.accounts.balances(user);
  }

  /** Drawer: "see drawer balances"; safe and bank as above (checked in the service). */
  @Authenticated()
  @Get("movements")
  movements(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.accounts.movements(user, parse(movementSearchSchema, query));
  }

  @RequirePermission("sup.transfers")
  @Post("transfers")
  @HttpCode(200)
  transfer(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.transfer(ctx, user, parse(transferSchema, body));
  }

  @RequirePermission("sup.insurer_payments_withdrawals")
  @Post("insurer-payments")
  @HttpCode(200)
  payInsurer(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.payInsurer(ctx, user, parse(insurerPaymentSchema, body));
  }

  @RequirePermission("sup.insurer_payments_withdrawals")
  @Post("withdrawals")
  @HttpCode(200)
  withdraw(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.withdraw(ctx, user, parse(withdrawalSchema, body));
  }

  /** The power of the original movement is checked in the service. */
  @Authenticated()
  @Post("reverse")
  @HttpCode(200)
  reverse(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.reverse(ctx, user, parse(reverseSchema, body));
  }

  @ManagerOnly()
  @Put("bank-negative")
  bankNegative(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.setBankNegative(ctx, user, parse(bankNegativeSchema, body).allow);
  }

  /** Checked in the service (safe and bank visibility). */
  @Authenticated()
  @Get("withdrawal-reasons")
  reasons(@CurrentUser() user: AuthUser) {
    return this.accounts.reasons(user);
  }

  @ManagerOnly()
  @Post("withdrawal-reasons")
  addReason(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.accounts.addReason(ctx, user, parse(listItemSchema, body).name);
  }

  @ManagerOnly()
  @Post("withdrawal-reasons/:id/archive")
  @HttpCode(200)
  archiveReason(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(listItemArchiveSchema, body);
    return this.accounts.archiveReason(ctx, user, id, input.version, input.archived);
  }
}

export const CASH_CONTROLLERS = [DrawerController, ExpensesController, CashAccountsController];
