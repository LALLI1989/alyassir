import { describe, expect, it } from "vitest";
import { claimDateProblem, claimReopen, isInstalmentReminded, lastDeclarationDay, renderTemplate, toWhatsappNumber } from "./index";

const year = { startDate: "2026-01-01", endDate: "2026-12-31", validity: "active" as const, cancelledOn: null };

describe("claims: cover and 5 days to declare (owner decisions 28/10/2026)", () => {
  it("accident on the last day, declared 04/01: accepted", () => {
    expect(lastDeclarationDay("2026-12-31")).toBe("2027-01-04");
    expect(claimDateProblem(year, "2026-12-31", "2027-01-04")).toBeNull();
  });
  it("declared 05/01: too late", () => {
    expect(claimDateProblem(year, "2026-12-31", "2027-01-05")).toBe("late_declaration");
  });
  it("before the start, or after the end: refused", () => {
    expect(claimDateProblem(year, "2025-12-15", "2025-12-16")).toBe("before_start");
    expect(claimDateProblem(year, "2027-01-01", "2027-01-02")).toBe("after_cover");
  });
  it("annulled: never covered; cancelled: covered up to the cancellation day", () => {
    expect(claimDateProblem({ ...year, validity: "annulled" }, "2026-03-01", "2026-03-02")).toBe("annulled");
    const cancelled = { ...year, validity: "cancelled" as const, cancelledOn: "2026-06-30" };
    expect(claimDateProblem(cancelled, "2026-06-30", "2026-07-01")).toBeNull();
    expect(claimDateProblem(cancelled, "2026-07-01", "2026-07-02")).toBe("after_cover");
  });
  it("an accident cannot be in the future; a declaration the same day is fine", () => {
    expect(claimDateProblem(year, "2026-05-10", "2026-05-09")).toBe("accident_in_future");
    expect(claimDateProblem(year, "2026-05-10", "2026-05-10")).toBeNull();
  });
  it("closed and rejected claims come back only by the manager", () => {
    expect(claimReopen("closed", "processing")).toBe(true);
    expect(claimReopen("rejected", "declared")).toBe(true);
    expect(claimReopen("expertise", "processing")).toBe(false);
    expect(claimReopen("closed", "closed")).toBe(false);
  });
});

describe("WhatsApp (SPEC 18.4)", () => {
  it("local numbers become international, without +", () => {
    expect(toWhatsappNumber("0612345678")).toBe("212612345678");
    expect(toWhatsappNumber("07 12 34 56 78")).toBe("212712345678");
    expect(toWhatsappNumber("0522334455")).toBe("212522334455");
    expect(toWhatsappNumber("+33612345678")).toBe("33612345678");
    expect(toWhatsappNumber("0033612345678")).toBe("33612345678");
    expect(toWhatsappNumber("12345")).toBeNull();
  });
  it("fills the template; unknown names stay", () => {
    expect(renderTemplate("Bonjour {client}, police {policy}, reste {remaining} {x}", { client: "Said", policy: "POL-1", remaining: "1 500,00 MAD" })).toBe(
      "Bonjour Said, police POL-1, reste 1 500,00 MAD {x}",
    );
  });
});

describe("reminders (SPEC 18.2)", () => {
  it("an instalment due 10/11 is reminded from 07/11", () => {
    expect(isInstalmentReminded("2026-11-10", "2026-11-06", 3)).toBe(false);
    expect(isInstalmentReminded("2026-11-10", "2026-11-07", 3)).toBe(true);
    expect(isInstalmentReminded("2026-11-10", "2026-11-12", 3)).toBe(true);
  });
});
