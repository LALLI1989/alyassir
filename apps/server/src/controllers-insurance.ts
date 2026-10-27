/** Phase 2 routes: insurance settings, clients, vehicles, policies. Each one declares its access. */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  annulSchema,
  archiveSchema,
  cancelSchema,
  clientSchema,
  clientSearchSchema,
  coverageDurationSchema,
  createPolicySchema,
  customOperationSchema,
  datesPreviewSchema,
  duplicateSchema,
  fleetAddSchema,
  fleetRemoveSchema,
  insuranceTypeSchema,
  insurerSchema,
  operationTypeSchema,
  plateChangeSchema,
  policyChangeSchema,
  policySearchSchema,
  renewSchema,
  updateClientSchema,
  updateInsuranceTypeSchema,
  updateInsurerSchema,
  updateOperationTypeSchema,
  updatePolicySchema,
  updateVehicleSchema,
  vehicleChangePreviewSchema,
  vehicleChangeSchema,
  vehicleSchema,
} from "@alyassir/shared";
import { ClientsService } from "./clients/clients.service";
import { Authenticated, ManagerOnly, PermissionOrGrant, RequirePermission } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";
import { CatalogService } from "./insurance/catalog.service";
import { PoliciesService } from "./policies/policies.service";
import { PolicyOperationsService } from "./policies/policy-operations.service";
import { PolicyReader } from "./policies/policy-reader";
import { VehiclesService } from "./vehicles/vehicles.service";

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ApiException("NOT_FOUND") });
const vehicleQuery = z.object({ q: z.string().trim().max(30).default("") });
const operationCode = z.string().regex(/^custom_[a-z0-9]{6,20}$/);

@Controller("insurance")
export class InsuranceController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  /** Lists used by every policy form (archived items included, marked). */
  @Authenticated()
  @Get("catalog")
  get() {
    return this.catalog.catalog();
  }

  @ManagerOnly()
  @Post("insurers")
  createInsurer(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.catalog.createInsurer(ctx, parse(insurerSchema, body).name);
  }

  @ManagerOnly()
  @Patch("insurers/:id")
  updateInsurer(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(updateInsurerSchema, body);
    return this.catalog.updateInsurer(ctx, id, input.version, input.name);
  }

  @ManagerOnly()
  @Post("insurers/:id/archive")
  @HttpCode(200)
  archiveInsurer(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(archiveSchema, body);
    return this.catalog.setArchived(ctx, "insurer", id, input.version, input.archived);
  }

  @ManagerOnly()
  @Post("types")
  createType(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.catalog.createType(ctx, parse(insuranceTypeSchema, body));
  }

  @ManagerOnly()
  @Patch("types/:id")
  updateType(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(updateInsuranceTypeSchema, body);
    return this.catalog.updateType(ctx, id, input.version, { nameAr: input.nameAr, nameFr: input.nameFr });
  }

  @ManagerOnly()
  @Post("types/:id/archive")
  @HttpCode(200)
  archiveType(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(archiveSchema, body);
    return this.catalog.setArchived(ctx, "insurance_type", id, input.version, input.archived);
  }

  @ManagerOnly()
  @Post("durations")
  createDuration(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.catalog.createDuration(ctx, parse(coverageDurationSchema, body).months);
  }

  @ManagerOnly()
  @Post("durations/:id/archive")
  @HttpCode(200)
  archiveDuration(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(archiveSchema, body);
    return this.catalog.setArchived(ctx, "coverage_duration", id, input.version, input.archived);
  }

  @ManagerOnly()
  @Post("operation-types")
  createOperationType(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.catalog.createOperationType(ctx, parse(operationTypeSchema, body));
  }

  @ManagerOnly()
  @Patch("operation-types/:code")
  updateOperationType(@Param("code") code: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(updateOperationTypeSchema, body);
    return this.catalog.updateOperationType(ctx, parse(operationCode, code), input.version, { nameAr: input.nameAr, nameFr: input.nameFr });
  }

  @ManagerOnly()
  @Post("operation-types/:code/archive")
  @HttpCode(200)
  archiveOperationType(@Param("code") code: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(archiveSchema, body);
    return this.catalog.setArchived(ctx, "operation_type", parse(operationCode, code), input.version, input.archived);
  }
}

@Controller("clients")
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  @RequirePermission("clients.view")
  @Get()
  search(@Query() query: unknown) {
    return this.clients.search(parse(clientSearchSchema, query));
  }

  @RequirePermission("clients.view")
  @Get(":id")
  file(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.clients.file(user, id);
  }

  @RequirePermission("clients.create")
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.clients.create(ctx, parse(clientSchema, body));
  }

  @PermissionOrGrant("clients.edit")
  @Patch(":id")
  update(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.clients.update(ctx, user, id, parse(updateClientSchema, body));
  }

  @PermissionOrGrant("clients.edit")
  @Post(":id/archive")
  @HttpCode(200)
  archive(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(archiveSchema, body);
    return this.clients.setArchived(ctx, user, id, input.version, input.archived);
  }
}

@Controller("vehicles")
export class VehiclesController {
  constructor(@Inject(VehiclesService) private readonly vehicles: VehiclesService) {}

  @RequirePermission("vehicles.view")
  @Get()
  search(@Query() query: unknown) {
    return this.vehicles.search(parse(vehicleQuery, query).q);
  }

  @RequirePermission("vehicles.view")
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.vehicles.get(id);
  }

  @RequirePermission("vehicles.create")
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.vehicles.create(ctx, parse(vehicleSchema, body));
  }

  @PermissionOrGrant("vehicles.edit")
  @Patch(":id")
  update(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.vehicles.update(ctx, user, id, parse(updateVehicleSchema, body));
  }

  @PermissionOrGrant("vehicles.edit")
  @Post(":id/archive")
  @HttpCode(200)
  archive(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    const input = parse(archiveSchema, body);
    return this.vehicles.setArchived(ctx, user, id, input.version, input.archived);
  }
}

@Controller("policies")
export class PoliciesController {
  constructor(
    @Inject(PoliciesService) private readonly policies: PoliciesService,
    @Inject(PolicyOperationsService) private readonly operations: PolicyOperationsService,
    @Inject(PolicyReader) private readonly reader: PolicyReader,
  ) {}

  @RequirePermission("policies.view")
  @Get()
  search(@Query() query: unknown) {
    return this.reader.search(parse(policySearchSchema, query));
  }

  /** The end date the server will use, shown before saving (the screen does not compute dates). */
  @RequirePermission("policies.view")
  @Post("dates-preview")
  @HttpCode(200)
  datesPreview(@Body() body: unknown) {
    const input = parse(datesPreviewSchema, body);
    return this.policies.datesPreview(input.coverageDurationId, input.startDate);
  }

  /** Difference, fee and net shown in the confirmation window (SPEC 15). */
  @RequirePermission("policies.view")
  @Post("vehicle-change-preview")
  @HttpCode(200)
  vehicleChangePreview(@Body() body: unknown) {
    const input = parse(vehicleChangePreviewSchema, body);
    return this.operations.vehicleChangePreview(input.oldPriceCents, input.newPriceCents);
  }

  @RequirePermission("policies.view")
  @Get("fee-preview")
  feePreview() {
    return this.operations.feePreview();
  }

  @RequirePermission("policies.view")
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.reader.get(id);
  }

  @RequirePermission("policies.create")
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.policies.create(ctx, user, parse(createPolicySchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Patch(":id")
  update(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.policies.update(ctx, user, id, parse(updatePolicySchema, body));
  }

  @PermissionOrGrant("policies.create")
  @Post(":id/renew")
  @HttpCode(200)
  renew(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.policies.renew(ctx, user, id, parse(renewSchema, body));
  }

  @PermissionOrGrant("policies.create")
  @Post(":id/change")
  @HttpCode(200)
  change(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.policies.change(ctx, user, id, parse(policyChangeSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/vehicle-change")
  @HttpCode(200)
  vehicleChange(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.vehicleChange(ctx, user, id, parse(vehicleChangeSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/plate-change")
  @HttpCode(200)
  plateChange(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.plateChange(ctx, user, id, parse(plateChangeSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/duplicate")
  @HttpCode(200)
  duplicate(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.duplicate(ctx, user, id, parse(duplicateSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/fleet/add")
  @HttpCode(200)
  fleetAdd(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.fleetAdd(ctx, user, id, parse(fleetAddSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/fleet/remove")
  @HttpCode(200)
  fleetRemove(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.fleetRemove(ctx, user, id, parse(fleetRemoveSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/annul")
  @HttpCode(200)
  annul(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.annul(ctx, user, id, parse(annulSchema, body));
  }

  /** Résiliation: the manager decides the refund (SPEC 13.2). */
  @ManagerOnly()
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.cancel(ctx, user, id, parse(cancelSchema, body));
  }

  @PermissionOrGrant("policies.edit")
  @Post(":id/operations")
  @HttpCode(200)
  custom(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.operations.custom(ctx, user, id, parse(customOperationSchema, body));
  }
}

export const INSURANCE_CONTROLLERS = [InsuranceController, ClientsController, VehiclesController, PoliciesController];
