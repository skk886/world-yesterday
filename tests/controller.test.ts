import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertRunAllowed,
  chooseTargetDate,
  stripNullObjectFields,
  toCodexOutputSchema,
  type LocalState
} from "../scripts/controller";
import { editionSchema } from "../src/lib/schema";

describe("catch-up ordering", () => {
  it("publishes the latest complete day before older gaps", () => {
    expect(chooseTargetDate(["2026-08-25", "2026-08-24", "2026-08-23"], ["2026-08-24"], "2026-08-25")).toBe("2026-08-25");
  });

  it("still chooses the latest day when its cloud snapshot is late", () => {
    expect(chooseTargetDate(["2026-08-24", "2026-08-23"], [], "2026-08-25")).toBe("2026-08-25");
  });

  it("then fills remaining gaps newest to oldest", () => {
    expect(chooseTargetDate(["2026-08-25", "2026-08-24", "2026-08-23"], ["2026-08-25"], "2026-08-25")).toBe("2026-08-24");
  });

  it("ignores future snapshots", () => {
    expect(chooseTargetDate(["2026-08-27", "2026-08-25"], [], "2026-08-25")).toBe("2026-08-25");
  });

  it("produces the structured-output schema used by Codex", () => {
    expect(() => z.toJSONSchema(editionSchema, { target: "draft-7" })).not.toThrow();
  });

  it("adapts optional URLs to the Responses strict-schema subset", () => {
    const schema = toCodexOutputSchema({
      type: "object",
      properties: {
        title: { type: "string" },
        url: { type: "string", format: "uri" }
      },
      required: ["title"]
    }) as any;
    expect(schema.required).toEqual(["title", "url"]);
    expect(schema.properties.url).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(stripNullObjectFields({ title: "news", url: null })).toEqual({ title: "news" });
  });

  it("enforces two editions per Shanghai day and the 90-minute cooldown", () => {
    const now = new Date("2026-08-26T04:00:00Z");
    const twoRuns: LocalState = {
      schemaVersion: 1,
      runs: [
        { date: "2026-08-25", completedAt: "2026-08-26T01:00:00Z", tokenTotal: 10, published: true },
        { date: "2026-08-24", completedAt: "2026-08-26T03:00:00Z", tokenTotal: 10, published: true }
      ]
    };
    expect(() => assertRunAllowed(twoRuns, now, false)).toThrow(/Daily catch-up limit/);
    expect(() => assertRunAllowed({ schemaVersion: 1, runs: [], nextEligibleAt: "2026-08-26T04:30:00Z" }, now, false)).toThrow(/Cooldown active/);
    expect(() => assertRunAllowed(twoRuns, now, true)).not.toThrow();
  });
});
