import { describe, expect, it } from "vitest";
import { editionSchema, rawSnapshotSchema, type Edition } from "../src/lib/schema";
import { findAllowedSource, isAllowedUrl, loadSourceRegistry } from "../scripts/lib/sources";
import { validateEditionSemantics, validateRawSnapshotSemantics } from "../scripts/validate";
import fs from "node:fs";

function editionWithOneItem(): Edition {
  return editionSchema.parse({
    schemaVersion: 2,
    siteName: "昨日世界 / World Yesterday",
    date: "2026-08-25",
    generatedAt: "2026-08-26T04:00:00Z",
    timezone: "Asia/Shanghai",
    status: "partial",
    items: [{
      id: "nasa-example-event",
      category: "science",
      rank: 1,
      titles: { zh: "用于测试的一手科学机构公告", en: "A primary science agency test announcement" },
      originalTitle: "A primary science agency test announcement",
      summaries: {
        zh: "这是一条仅用于自动化测试的示例摘要，用来确认中文长度、日期边界、来源白名单和一手证据规则都会由发布前校验器严格执行。",
        en: "This synthetic entry exists only to test the publication validator. It confirms that summary length, Shanghai date boundaries, source allowlisting, primary evidence, bilingual fields, and metric consistency are checked before any edition can be published to the public website."
      },
      whyItMatters: { zh: "它能阻止格式正确但证据不足的内容上线。", en: "It prevents structurally valid but weakly sourced content from going live." },
      sources: [{
        name: "NASA", url: "https://www.nasa.gov/example", domain: "nasa.gov", type: "primary", language: "en", publishedAt: "2026-08-25T02:00:00Z"
      }],
      verificationStatus: "verified",
      publishedAt: "2026-08-25T02:00:00Z",
      updatedAt: "2026-08-26T04:00:00Z",
      regions: ["Global"],
      topic: "aerospace",
      subjectOrganization: { id: "nasa", name: "NASA" },
      importanceFactors: { impactBreadth: 80, consequenceSeverity: 80, systemicSignificance: 80, independentCoverage: 80, yesterdayNovelty: 80 },
      impactScore: 80
    }],
    metrics: {
      candidateCount: 1, pagesOpened: 1, searchGroups: 0, verifiedCount: 1, pendingCount: 0, rejectedCount: 0,
      tokenUsage: { measured: false, candidateJudgment: 0, verification: 0, bilingualGeneration: 0, contentChecks: 0, repairReserve: 0, input: 0, output: 0, total: 0 }
    }
  });
}

describe("allowlist and semantic publishing gate", () => {
  it("allows registered subdomains and rejects unknown sites", () => {
    const sources = loadSourceRegistry();
    expect(findAllowedSource("https://science.nasa.gov/story", sources)?.id).toBe("nasa");
    expect(isAllowedUrl("https://random-blog.invalid/story", sources)).toBe(false);
    expect(findAllowedSource("https://tass.com/story", sources)?.type).toBe("state-media");
  });

  it("accepts a primary source that proves its own announcement", () => {
    expect(validateEditionSemantics(editionWithOneItem())).toEqual({ valid: true, errors: [] });
  });

  it("rejects an out-of-list citation", () => {
    const edition = editionWithOneItem();
    edition.items[0].sources[0].url = "https://random-blog.invalid/story";
    const result = validateEditionSemantics(edition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("outside the allowlist");
  });

  it("enforces the five-item pending ceiling", () => {
    const edition = editionWithOneItem();
    edition.items = Array.from({ length: 6 }, (_, index) => ({
      ...structuredClone(edition.items[0]),
      id: `pending-event-${index + 1}`,
      rank: index + 1,
      verificationStatus: "pending" as const,
      pendingReason: { zh: "仍缺少第二个独立来源。", en: "A second independent source is still missing." }
    }));
    edition.metrics.verifiedCount = 0;
    edition.metrics.pendingCount = 5;
    const result = validateEditionSemantics(edition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Pending items exceed limit: 6/5");
  });

  it("keeps the local visual fixture within the publication rules", () => {
    const demo = editionSchema.parse(JSON.parse(fs.readFileSync("data/demo/edition.json", "utf8")));
    expect(validateEditionSemantics(demo)).toEqual({ valid: true, errors: [] });
  });

  it("rejects tampered raw snapshot source metadata", () => {
    const raw = rawSnapshotSchema.parse({
      schemaVersion: 1, date: "2026-08-25", timezone: "Asia/Shanghai", collectedAt: "2026-08-26T00:00:00Z",
      window: { start: "2026-08-24T16:00:00Z", end: "2026-08-25T15:59:59.999Z" },
      candidates: [{
        id: "candidate-1", title: "Test", url: "https://www.nasa.gov/test", canonicalUrl: "https://www.nasa.gov/test",
        sourceId: "bbc", sourceName: "BBC News", domain: "nasa.gov", sourceType: "independent-media", sourceTier: "B", language: "en",
        publishedAt: "2026-08-25T02:00:00Z", discovery: "rss", categoryHints: ["science"], topic: "aerospace", preliminaryScore: 50
      }], sourceResults: [], notes: []
    });
    expect(validateRawSnapshotSemantics(raw).valid).toBe(false);
  });
});
