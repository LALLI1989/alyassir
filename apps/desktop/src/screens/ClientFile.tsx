import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClientDto, ClientFileDto, VehicleDto } from "@alyassir/shared";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { PageHeader } from "../components/common";
import { Code, Money, ValidityBadge, formatDay } from "../components/insurance";
import { ErrorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { ClientDialog, clientDisplayName } from "./Clients";
import type { Page } from "./Shell";
import { Debts } from "./Payments";
import { PlateHistory, VehicleDialog } from "./Vehicles";

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function ClientFile({ id, onOpen }: { id: string; onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const queries = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: "edit" } | { kind: "vehicle"; vehicle?: VehicleDto } | null>(null);
  const file = useQuery({ queryKey: ["client", id], queryFn: () => api<ClientFileDto>("GET", `/api/clients/${id}`) });
  const archive = useMutation({
    mutationFn: (c: ClientDto) => api<ClientDto>("POST", `/api/clients/${c.id}/archive`, { version: c.version, archived: !c.archived }),
    onSettled: () => queries.invalidateQueries({ queryKey: ["client", id] }),
  });
  if (file.error) return <ErrorMessage error={asClientError(file.error)} />;
  if (!file.data) return null;
  const { client, vehicles, policies } = file.data;

  return (
    <div className="grid gap-5">
      <PageHeader
        title={clientDisplayName(client)}
        intro={t(`clients.kinds.${client.kind}`)}
        actions={
          <>
            {can("policies.create") && !client.archived && <Button onClick={() => onOpen({ kind: "policyNew", clientId: client.id })}>{t("clients.newPolicy")}</Button>}
            <Button variant="outline" onClick={() => setDialog({ kind: "edit" })}>{t("common.edit")}</Button>
            <Button variant="ghost" onClick={() => archive.mutate(client)} disabled={archive.isPending}>{client.archived ? t("common.restore") : t("common.archive")}</Button>
          </>
        }
      />
      {archive.error && <ErrorMessage error={asClientError(archive.error)} />}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("clients.identity")}
            {client.archived && <Badge variant="outline">{t("common.archived")}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Line label={client.kind === "company" ? t("clients.contactName") : t("clients.fullName")}><span dir="auto">{client.fullName}</span></Line>
          <Line label={t(`clients.idTypes.${client.idType}`)}><Code>{client.idNumber}</Code></Line>
          <Line label={t("clients.phone")}><Code>{client.phone}</Code></Line>
          {client.residency && <Line label={t("clients.residency")}>{t(`clients.residencies.${client.residency}`)}</Line>}
          <Line label={t("clients.createdAt")}>{formatDateTime(client.createdAt)}</Line>
        </CardContent>
      </Card>

      {can("vehicles.view") && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t("clients.vehicles")}</CardTitle>
            {can("vehicles.create") && !client.archived && <Button size="sm" onClick={() => setDialog({ kind: "vehicle" })}>{t("vehicles.add")}</Button>}
          </CardHeader>
          <CardContent>
            {vehicles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("clients.noVehicles")}</p>
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("vehicles.plate")}</Th>
                    <Th>{t("vehicles.brand")}</Th>
                    <Th>{t("vehicles.fiscalPower")}</Th>
                    <Th>{t("vehicles.fuel")}</Th>
                    <Th>{t("policies.validity")}</Th>
                    <Th />
                  </Tr>
                </THead>
                <TBody>
                  {vehicles.map((v) => (
                    <Tr key={v.id}>
                      <Td>
                        <div className="grid gap-1">
                          <Code>{v.plate}</Code>
                          <span className="text-xs text-muted-foreground">{t(`vehicles.plateTypes.${v.plateType}`)}</span>
                          <PlateHistory vehicle={v} />
                        </div>
                      </Td>
                      <Td dir="auto">{v.brand}</Td>
                      <Td>{v.fiscalPower}</Td>
                      <Td>{t(`vehicles.fuels.${v.fuel}`)}</Td>
                      <Td>
                        {v.activePolicyId ? (
                          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: v.activePolicyId as string })}>
                            {t("vehicles.insuredBy", { number: v.activePolicyNumber })}
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">{t("vehicles.notInsured")}</span>
                        )}
                      </Td>
                      <Td className="text-end">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "vehicle", vehicle: v })}>{t("common.edit")}</Button>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {can("policies.view") && (
        <Card>
          <CardHeader>
            <CardTitle>{t("clients.policies")}</CardTitle>
          </CardHeader>
          <CardContent>
            {policies.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("clients.noPolicies")}</p>
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("policies.number")}</Th>
                    <Th>{t("policies.type")}</Th>
                    <Th>{t("policies.vehicles")}</Th>
                    <Th>{t("policies.end")}</Th>
                    <Th>{t("policies.amount")}</Th>
                    <Th>{t("policies.validity")}</Th>
                    <Th />
                  </Tr>
                </THead>
                <TBody>
                  {policies.map((p) => (
                    <Tr key={p.id}>
                      <Td><Code>{p.policyNumber}</Code></Td>
                      <Td dir="ltr">{p.typeName}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">{p.plates.map((plate) => <Code key={plate}>{plate}</Code>)}</div>
                      </Td>
                      <Td>{formatDay(p.endDate)}</Td>
                      <Td><Money cents={p.totalAmountCents} /></Td>
                      <Td><ValidityBadge validity={p.validity} /></Td>
                      <Td className="text-end">
                        <Button size="sm" variant="outline" onClick={() => onOpen({ kind: "policy", id: p.id })}>{t("common.open")}</Button>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {can("debts.view") && (
        <Card>
          <CardHeader>
            <CardTitle>{t("finance.debts")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Debts clientId={client.id} onOpen={onOpen} />
          </CardContent>
        </Card>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent closeLabel={t("common.close")}>
          {dialog?.kind === "edit" && <ClientDialog client={client} onCancel={() => setDialog(null)} onDone={() => setDialog(null)} />}
          {dialog?.kind === "vehicle" && <VehicleDialog clientId={client.id} vehicle={dialog.vehicle} onCancel={() => setDialog(null)} onDone={() => setDialog(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
