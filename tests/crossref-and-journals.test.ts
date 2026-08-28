import { describe, expect, it, vi } from "vitest";
import { enrichScienceCandidates, cleanCrossrefAbstract, extractDoi } from "../scripts/lib/crossref";
import { isJournalHighlightEligible, selectJournalReserves } from "../scripts/lib/journals";
import { selectBalanced } from "../scripts/collect";
import type { RawCandidate } from "../src/lib/schema";

function candidate(sourceId: "science" | "nature" | "bbc", index: number, description?: string): RawCandidate {
  const doi = sourceId === "science" ? `10.1126/science.test${index}` : undefined;
  const domain = sourceId === "science" ? "science.org" : sourceId === "nature" ? "nature.com" : "bbc.com";
  const url = sourceId === "science"
    ? `https://www.science.org/doi/abs/${doi}?af=R`
    : `https://www.${domain}/articles/item-${index}`;
  return {
    id: `${sourceId}${String(index).padStart(10, "0")}`.slice(0, 16),
    title: `${sourceId} research item ${index}`,
    url,
    canonicalUrl: url,
    sourceId,
    sourceName: sourceId === "science" ? "Science" : sourceId === "nature" ? "Nature" : "BBC News",
    domain,
    sourceType: "independent-media",
    sourceTier: "B",
    language: "en",
    publishedAt: "2026-08-27T06:00:00Z",
    description,
    rssDescription: description,
    doi,
    discovery: "rss",
    categoryHints: ["science"],
    topic: "life-sciences",
    preliminaryScore: 80 - index
  };
}

describe("Science DOI enrichment", () => {
  it("extracts normalized DOI values and sanitizes JATS abstracts", () => {
    expect(extractDoi("https://www.science.org/doi/abs/10.1126/SCIENCE.ABC123?af=R")).toBe("10.1126/science.abc123");
    expect(cleanCrossrefAbstract("<jats:p><b>Abstract</b> A sufficiently long &amp; useful abstract with more than eighty characters describing methods, observations, and scientific implications for readers.</jats:p>"))
      .toContain("A sufficiently long & useful abstract");
  });

  it("replaces Science bibliographic text only after an exact DOI match", async () => {
    const abstract = "This publisher-deposited abstract is deliberately longer than eighty characters and describes the study methods, central result, and scientific implications without relying on the RSS issue line.";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", message: { DOI: "10.1126/science.test1", abstract: `<jats:p>${abstract}</jats:p>` } }), { status: 200 }));
    const original = candidate("science", 1, "Science, Volume 393, Issue 6814, Page 1-5, August 2026.");
    const result = await enrichScienceCandidates([original], { fetcher: fetcher as typeof fetch, attempts: 1, now: () => new Date("2026-08-28T00:00:00Z") });
    expect(result.candidates[0].description).toBe(abstract);
    expect(result.candidates[0].rssDescription).toContain("Volume 393");
    expect(result.candidates[0].metadataEnrichment?.status).toBe("enriched");
    expect(isJournalHighlightEligible(result.candidates[0])).toBe(true);
  });

  it("rejects a mismatched DOI and keeps the RSS description", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", message: { DOI: "10.1126/science.different", abstract: "A long abstract that must not be attached to a different DOI even if every other field appears plausible and complete." } }), { status: 200 }));
    const original = candidate("science", 2, "Science, Volume 393, Issue 6814, August 2026.");
    const result = await enrichScienceCandidates([original], { fetcher: fetcher as typeof fetch, attempts: 1, now: () => new Date("2026-08-28T00:00:00Z") });
    expect(result.candidates[0].description).toBe(original.description);
    expect(result.candidates[0].metadataEnrichment?.status).toBe("error");
    expect(isJournalHighlightEligible(result.candidates[0])).toBe(false);
  });
});

describe("fixed journal reserves", () => {
  it("keeps up to four Science and four Nature candidates ahead of balanced truncation", () => {
    const science = Array.from({ length: 8 }, (_, index) => candidate("science", index, "A substantive Crossref abstract that is long enough to support cautious editorial selection and a factual bilingual summary for the daily journal watch card."))
      .map((item) => ({ ...item, metadataEnrichment: { provider: "crossref" as const, status: "enriched" as const, doi: item.doi!, fetchedAt: "2026-08-28T00:00:00Z", abstract: item.description! } }));
    const nature = Array.from({ length: 8 }, (_, index) => candidate("nature", index, "Nature reports a substantive scientific development with enough publisher-supplied detail to support editorial selection without opening the article page."));
    const general = Array.from({ length: 100 }, (_, index) => candidate("bbc", index, "General candidate."));
    const reserves = selectJournalReserves([...general, ...science, ...nature]);
    expect(reserves.filter((item) => item.sourceId === "science")).toHaveLength(4);
    expect(reserves.filter((item) => item.sourceId === "nature")).toHaveLength(4);
    const selected = selectBalanced([...general, ...science, ...nature], 20);
    expect(selected.filter((item) => item.sourceId === "science")).toHaveLength(4);
    expect(selected.filter((item) => item.sourceId === "nature")).toHaveLength(4);
  });
});
