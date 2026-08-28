import { describe, expect, it } from "vitest";
import { editionSchema, editionV4Schema, rawSnapshotSchema, type Edition } from "../src/lib/schema";
import { findAllowedSource, isAllowedUrl, loadSourceRegistry } from "../scripts/lib/sources";
import { validateEditionSemantics, validateRawSnapshotSemantics } from "../scripts/validate";
import fs from "node:fs";

function editionWithOneItem(): Edition {
  return editionSchema.parse({
    schemaVersion: 3,
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
    expect(sources).toHaveLength(42);
    expect(sources.filter((source) => source.feeds.length > 0)).toHaveLength(32);
    expect(sources.every((source) => source.homepage.startsWith("https://"))).toBe(true);
    expect(findAllowedSource("https://science.nasa.gov/story", sources)?.id).toBe("nasa");
    expect(isAllowedUrl("https://random-blog.invalid/story", sources)).toBe(false);
    expect(findAllowedSource("https://tass.com/story", sources)?.type).toBe("state-media");
  });

  it("does not treat sister publications as independent verification", () => {
    const edition = editionWithOneItem();
    edition.items[0].category = "entertainment";
    edition.items[0].topic = "film-television";
    edition.items[0].subjectOrganization = null;
    edition.items[0].sources = [
      { name: "Variety", url: "https://variety.com/2026/film/news/example-123/", domain: "variety.com", type: "independent-media", language: "en", publishedAt: "2026-08-25T02:00:00Z" },
      { name: "Deadline", url: "https://deadline.com/2026/08/example-123/", domain: "deadline.com", type: "independent-media", language: "en", publishedAt: "2026-08-25T03:00:00Z" }
    ];
    edition.metrics.candidateCount = 2;
    edition.metrics.rejectedCount = 1;
    const result = validateEditionSemantics(edition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("two independent publisher groups");
  });

  it("accepts a primary source that proves its own announcement", () => {
    expect(validateEditionSemantics(editionWithOneItem())).toEqual({ valid: true, errors: [] });
  });

  it("requires fixed Science and Nature slots in Schema 4 and rejects ranked duplicates", () => {
    const legacy = editionWithOneItem();
    const edition = editionV4Schema.parse({
      ...legacy,
      schemaVersion: 4,
      metrics: { ...legacy.metrics, candidateCount: 2, rejectedCount: 0 },
      journalHighlights: [
        {
          journal: "science",
          journalName: "Science",
          status: "selected",
          candidateId: "0123456789abcdef",
          originalTitle: "A test Science paper",
          titles: { zh: "用于验证期刊精选结构的科学论文", en: "A Science paper used to validate Journal Watch" },
          summaries: {
            zh: "这段合成摘要只用于确认期刊精选的日期、链接、DOI、来源属性和中英文结构能够在发布前得到验证。",
            en: "This synthetic journal summary exists only to verify the date, DOI, original link, metadata provenance, bilingual structure, and duplicate protections applied before a Journal Watch entry can be published."
          },
          whyItMatters: { zh: "它可以阻止来源混淆或重复内容进入版面。", en: "It prevents provenance confusion and duplicate content from entering the edition." },
          topic: "life-sciences",
          doi: "10.1126/science.test1",
          url: "https://www.science.org/doi/abs/10.1126/science.test1",
          publishedAt: "2026-08-25T03:00:00Z",
          metadataSource: "crossref",
          notice: { zh: "摘要由 DOI 精确匹配的 Crossref 元数据补充。", en: "The abstract was enriched from an exact DOI match in Crossref metadata." }
        },
        {
          journal: "nature",
          journalName: "Nature",
          status: "no-update",
          notice: { zh: "昨日没有新的合格条目。", en: "No eligible new entry was published yesterday." }
        }
      ]
    });
    expect(validateEditionSemantics(edition)).toEqual({ valid: true, errors: [] });

    edition.items[0].sources.push({
      name: "Science",
      url: "https://www.science.org/doi/abs/10.1126/science.test1",
      domain: "science.org",
      type: "independent-media",
      language: "en",
      publishedAt: "2026-08-25T03:00:00Z"
    });
    const duplicate = validateEditionSemantics(edition);
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.join(" ")).toContain("duplicates a ranked item DOI");
  });

  it("rejects an out-of-list citation", () => {
    const edition = editionWithOneItem();
    edition.items[0].sources[0].url = "https://random-blog.invalid/story";
    const result = validateEditionSemantics(edition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("outside the allowlist");
  });

  it("enforces the fifteen-item allowlisted single-source ceiling", () => {
    const edition = editionWithOneItem();
    edition.items = Array.from({ length: 16 }, (_, index) => ({
      ...structuredClone(edition.items[0]),
      id: `pending-event-${index + 1}`,
      rank: index + 1,
      verificationStatus: "pending" as const,
      pendingReason: { zh: "仍缺少第二个独立来源。", en: "A second independent source is still missing." }
    }));
    edition.metrics.verifiedCount = 0;
    edition.metrics.pendingCount = 15;
    const result = validateEditionSemantics(edition);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Single-source items exceed limit: 16/15");
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

  it("keeps an item first published yesterday even when it was updated the next day", () => {
    const raw = rawSnapshotSchema.parse({
      schemaVersion: 1, date: "2026-08-25", timezone: "Asia/Shanghai", collectedAt: "2026-08-26T12:00:00Z",
      window: { start: "2026-08-24T16:00:00Z", end: "2026-08-25T15:59:59.999Z" },
      candidates: [{
        id: "candidate-2", title: "Primary announcement", url: "https://www.nasa.gov/test", canonicalUrl: "https://www.nasa.gov/test",
        sourceId: "nasa", sourceName: "NASA", domain: "nasa.gov", sourceType: "primary", sourceTier: "A", language: "en",
        publishedAt: "2026-08-25T02:00:00Z", updatedAt: "2026-08-26T18:00:00Z", discovery: "rss",
        categoryHints: ["science"], topic: "aerospace", preliminaryScore: 50
      }], sourceResults: [], notes: []
    });
    expect(validateRawSnapshotSemantics(raw)).toEqual({ valid: true, errors: [] });
  });
});
