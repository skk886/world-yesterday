import { describe, expect, it } from "vitest";
import { canonicalizeUrl, deduplicateCandidates, titleSimilarity } from "../scripts/lib/candidates";
import { parseFeed } from "../scripts/lib/feed";
import type { RawCandidate } from "../src/lib/schema";

describe("RSS and candidate normalization", () => {
  it("parses an RSS item without copying article body", () => {
    const entries = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>Example headline</title><link>https://example.com/a</link><pubDate>Tue, 25 Aug 2026 03:00:00 GMT</pubDate><description>Short deck</description></item></channel></rss>`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "Example headline", url: "https://example.com/a", description: "Short deck" });
  });

  it("removes trackers and sorts stable query parameters", () => {
    expect(canonicalizeUrl("https://Example.com/story/?utm_source=x&b=2&a=1#top")).toBe("https://example.com/story?a=1&b=2");
  });

  it("recognizes similar multilingual-friendly titles and removes URL duplicates", () => {
    expect(titleSimilarity("Major climate summit opens in Brazil", "Brazil climate summit opens with major talks")).toBeGreaterThan(0.5);
    const base: RawCandidate = {
      id: "candidate-000001", title: "Major climate summit opens in Brazil", url: "https://bbc.com/news/1",
      canonicalUrl: "https://bbc.com/news/1", sourceId: "bbc", sourceName: "BBC News", domain: "bbc.com",
      sourceType: "independent-media", sourceTier: "B", language: "en", publishedAt: "2026-08-25T02:00:00Z",
      discovery: "rss", categoryHints: ["climate"], preliminaryScore: 50
    };
    expect(deduplicateCandidates([base, { ...base, preliminaryScore: 70 }])).toHaveLength(1);
    expect(deduplicateCandidates([base, { ...base, preliminaryScore: 70 }])[0].preliminaryScore).toBe(70);
  });
});

