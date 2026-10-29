import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORK_HOURS as WH,
  atLocal,
  backupFileName,
  dailySlot,
  firstFriday,
  hourlySlot,
  isExpired,
  isoWeekday,
  localClock,
  nextWorkingDay,
  parseBackupFileName,
  usbCopiesToRemove,
  usbGateState,
  usbGateTimes,
} from "./index";

describe("Casablanca clock", () => {
  it("wall time and back, whatever the offset of the day", () => {
    const at = atLocal("2026-10-31", "10:00");
    expect(localClock(at)).toEqual({ day: "2026-10-31", time: "10:00", hour: 10, weekday: 6 });
    expect(localClock(atLocal("2026-03-01", "23:30"))).toMatchObject({ day: "2026-03-01", time: "23:30" });
    expect(isoWeekday("2026-11-01")).toBe(7);
  });
});

describe("hourly backups: Monday to Saturday, 08:00 to 19:00", () => {
  it("Saturday 10:00 yes, Sunday no, before 08:00 and after the 19:00 hour no", () => {
    expect(hourlySlot(atLocal("2026-10-31", "10:00"), WH)).toBe("2026-10-31T10");
    expect(hourlySlot(atLocal("2026-11-01", "10:00"), WH)).toBeNull();
    expect(hourlySlot(atLocal("2026-11-02", "07:59"), WH)).toBeNull();
    expect(hourlySlot(atLocal("2026-11-02", "08:00"), WH)).toBe("2026-11-02T08");
    // Missed at 19:00 (server busy or just started): still taken in that hour, same slot.
    expect(hourlySlot(atLocal("2026-11-02", "19:30"), WH)).toBe("2026-11-02T19");
    expect(hourlySlot(atLocal("2026-11-02", "20:05"), WH)).toBeNull();
  });
});

describe("daily backup", () => {
  it("after the end of the working hours it is today's; before, yesterday's (caught up)", () => {
    expect(dailySlot(atLocal("2026-11-02", "19:00"), WH)).toBe("2026-11-02");
    expect(dailySlot(atLocal("2026-11-03", "09:15"), WH)).toBe("2026-11-02");
  });
});

describe("monthly USB copy (owner decision 29/10/2026)", () => {
  it("first Friday at 13:00 a reminder, blocking from Saturday 08:00", () => {
    expect(firstFriday("2026-11")).toBe("2026-11-06");
    expect(firstFriday("2027-01")).toBe("2027-01-01");
    expect(nextWorkingDay("2026-11-06", WH)).toBe("2026-11-07");
    expect(nextWorkingDay("2026-11-07", WH)).toBe("2026-11-09");
    const g = usbGateTimes("2026-11", WH, "13:00", atLocal("2026-11-01", "09:00"));
    expect(g.dueOn).toBe("2026-11-06");
    expect(localClock(g.remindFrom)).toMatchObject({ day: "2026-11-06", time: "13:00" });
    expect(localClock(g.blockFrom)).toMatchObject({ day: "2026-11-07", time: "08:00" });
    const gate = { ...g, doneAt: null, skippedAt: null };
    expect(usbGateState(gate, atLocal("2026-11-06", "12:59"))).toBe("none");
    expect(usbGateState(gate, atLocal("2026-11-06", "13:00"))).toBe("remind");
    expect(usbGateState(gate, atLocal("2026-11-07", "08:00"))).toBe("block");
    expect(usbGateState({ ...gate, doneAt: new Date() }, atLocal("2026-11-07", "09:00"))).toBe("none");
    expect(usbGateState({ ...gate, skippedAt: new Date() }, atLocal("2026-11-07", "09:00"))).toBe("none");
  });

  it("server off that Friday and Saturday: reminder at the first start, blocking from the next working day", () => {
    const g = usbGateTimes("2026-11", WH, "13:00", atLocal("2026-11-09", "08:30"));
    expect(localClock(g.blockFrom)).toMatchObject({ day: "2026-11-10", time: "08:00" });
  });

  it("the key keeps the 6 newest copies", () => {
    const names = ["alyassir-usb-2026-01-02-130000.dump", "alyassir-usb-2026-02-06-130000.dump", "alyassir-usb-2026-03-06-130000.dump",
      "alyassir-usb-2026-04-03-130000.dump", "alyassir-usb-2026-05-01-130000.dump", "alyassir-usb-2026-06-05-130000.dump", "alyassir-usb-2026-07-03-130000.dump"];
    expect(usbCopiesToRemove(names)).toEqual(["alyassir-usb-2026-01-02-130000.dump"]);
    expect(usbCopiesToRemove(names.slice(0, 3))).toEqual([]);
  });
});

describe("keeping times", () => {
  it("hourly 30 days, daily 6 months", () => {
    expect(isExpired("hourly", "2026-09-28", "2026-10-29")).toBe(true);
    expect(isExpired("hourly", "2026-09-29", "2026-10-29")).toBe(false);
    expect(isExpired("daily", "2026-05-29", "2026-10-29")).toBe(false);
    expect(isExpired("daily", "2026-04-28", "2026-10-29")).toBe(true);
  });

  it("file names sort by date and are read back", () => {
    const at = atLocal("2026-10-29", "10:05");
    expect(backupFileName("hourly", at)).toBe("alyassir-hourly-2026-10-29-1000.dump");
    expect(backupFileName("daily", at)).toBe("alyassir-daily-2026-10-29.dump");
    expect(backupFileName("manual", at)).toMatch(/^alyassir-manual-2026-10-29-1005\d\d\.dump$/);
    expect(parseBackupFileName("alyassir-hourly-2026-10-29-1000.dump")).toEqual({ kind: "hourly", day: "2026-10-29" });
    expect(parseBackupFileName("alyassir-daily-2026-10-29.dump")).toEqual({ kind: "daily", day: "2026-10-29" });
    expect(parseBackupFileName("notes.txt")).toBeNull();
  });
});
