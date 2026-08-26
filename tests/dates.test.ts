import { describe, expect, it } from "vitest";
import { dateIsInShanghaiDay, previousShanghaiDate, shanghaiDayWindow } from "../src/lib/dates";

describe("Asia/Shanghai date rules", () => {
  it("uses the previous complete natural day", () => {
    expect(previousShanghaiDate(new Date("2026-08-26T04:00:00Z"))).toBe("2026-08-25");
    expect(previousShanghaiDate(new Date("2026-08-25T16:05:00Z"))).toBe("2026-08-25");
  });

  it("includes both Shanghai day boundaries and excludes adjacent instants", () => {
    const window = shanghaiDayWindow("2026-08-25");
    expect(window.start.toISOString()).toBe("2026-08-24T16:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-25T15:59:59.999Z");
    expect(dateIsInShanghaiDay("2026-08-24T16:00:00.000Z", "2026-08-25")).toBe(true);
    expect(dateIsInShanghaiDay("2026-08-25T16:00:00.000Z", "2026-08-25")).toBe(false);
  });
});

