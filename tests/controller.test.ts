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
import { applyEditorialControls, computeImportanceScore } from "../scripts/lib/editorial";

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
    expect(stripNullObjectFields({ subjectOrganization: null, eventAt: null })).toEqual({ subjectOrganization: null });
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

  it("computes the published MCDA total instead of trusting a model total", () => {
    expect(computeImportanceScore({ impactBreadth: 90, consequenceSeverity: 80, systemicSignificance: 70, independentCoverage: 60, yesterdayNovelty: 50 })).toBe(75);
  });

  it("enforces organization and aerospace limits, then rebuilds ranks", () => {
    const factors = { impactBreadth: 80, consequenceSeverity: 80, systemicSignificance: 80, independentCoverage: 80, yesterdayNovelty: 80 };
    const makeItem = (id: string, rank: number, category: "world" | "technology" | "science", topic: "aerospace" | "general", organization: string, primary = false) => ({
      id,
      category,
      rank,
      titles: { zh: id, en: id },
      originalTitle: id,
      summaries: { zh: "用于测试控制器约束的中文摘要。", en: "A synthetic summary used to test deterministic editorial controls." },
      whyItMatters: { zh: "用于测试。", en: "Used for testing." },
      sources: [{ name: primary ? organization : "BBC News", url: primary ? `https://www.${organization.toLowerCase()}.gov/test-${rank}` : `https://www.bbc.com/test-${rank}`, domain: primary ? `${organization.toLowerCase()}.gov` : "bbc.com", type: primary ? "primary" as const : "independent-media" as const, language: "en", publishedAt: "2026-08-25T02:00:00Z" }],
      verificationStatus: "verified" as const,
      publishedAt: "2026-08-25T02:00:00Z",
      updatedAt: "2026-08-26T04:00:00Z",
      regions: ["Global"],
      topic,
      subjectOrganization: { id: organization.toLowerCase(), name: organization },
      importanceFactors: { ...factors, impactBreadth: 90 - rank },
      impactScore: 0
    });
    const edition = editionSchema.parse({
      schemaVersion: 3,
      siteName: "昨日世界 / World Yesterday",
      date: "2026-08-25",
      generatedAt: "2026-08-26T04:00:00Z",
      timezone: "Asia/Shanghai",
      status: "partial",
      items: [
        makeItem("nasa-science", 1, "science", "aerospace", "NASA", true),
        makeItem("nasa-technology", 2, "technology", "aerospace", "NASA", true),
        makeItem("nasa-world", 3, "world", "general", "NASA", true),
        makeItem("esa-science", 4, "science", "aerospace", "ESA", false),
        makeItem("spacex-technology", 5, "technology", "aerospace", "SpaceX", false),
        makeItem("nasa-science-two", 6, "science", "general", "NASA", true)
      ],
      metrics: { candidateCount: 6, pagesOpened: 0, searchGroups: 0, verifiedCount: 6, pendingCount: 0, rejectedCount: 0, tokenUsage: { measured: false, candidateJudgment: 0, verification: 0, bilingualGeneration: 0, contentChecks: 0, repairReserve: 0, input: 0, output: 0, total: 0 } }
    });
    const controlled = applyEditorialControls(edition);
    expect(controlled.items.filter((item) => item.subjectOrganization?.id === "nasa")).toHaveLength(2);
    expect(controlled.items.filter((item) => item.subjectOrganization?.id === "nasa" && item.category === "science")).toHaveLength(1);
    expect(controlled.items.filter((item) => item.topic === "aerospace" && ["science", "technology"].includes(item.category))).toHaveLength(3);
    expect(controlled.items.map((item) => item.rank)).toEqual(controlled.items.map((_, index) => index + 1));
    expect(controlled.items.every((item) => item.impactScore === computeImportanceScore(item.importanceFactors))).toBe(true);
  });
});
