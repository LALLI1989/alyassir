/** Phase 7 routes: historical entry mode. Each one declares its access. */
import { Body, Controller, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import { balanceCorrectionSchema, finishHistoricalSchema, historicalAnswerSchema, openingBalancesSchema } from "@alyassir/shared";
import { Authenticated, ManagerOnly } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { parse } from "./common/zod";
import { HistoricalService } from "./historical/historical.service";

@Controller("historical")
class HistoricalController {
  constructor(@Inject(HistoricalService) private readonly historical: HistoricalService) {}

  /** Everyone: the yellow bar and the "read only" screens depend on it. */
  @Authenticated()
  @Get()
  state() {
    return this.historical.state();
  }

  @ManagerOnly()
  @HttpCode(200)
  @Post("answer")
  answer(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.historical.answer(ctx, parse(historicalAnswerSchema, body).hasOldPolicies);
  }

  @ManagerOnly()
  @Put("opening")
  opening(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.historical.setOpening(ctx, user, parse(openingBalancesSchema, body));
  }

  @ManagerOnly()
  @Get("checklist")
  checklist() {
    return this.historical.checklist();
  }

  @ManagerOnly()
  @HttpCode(200)
  @Post("corrections")
  correct(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(balanceCorrectionSchema, body);
    return this.historical.correct(ctx, user, input.account, input.actualCents, input.reason);
  }

  @ManagerOnly()
  @HttpCode(200)
  @Post("finish")
  finish(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(finishHistoricalSchema, body);
    return this.historical.finish(ctx, user, input.password, input.phrase);
  }
}

export const HISTORICAL_CONTROLLERS = [HistoricalController];
