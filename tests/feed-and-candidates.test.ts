import { describe, expect, it } from "vitest";
import { canonicalizeUrl, classifyArticle, deduplicateCandidates, isExcludedCandidate, titleSimilarity } from "../scripts/lib/candidates";
import { selectBalanced } from "../scripts/collect";
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
      discovery: "rss", categoryHints: ["climate"], topic: "climate-environment", preliminaryScore: 50
    };
    expect(deduplicateCandidates([base, { ...base, preliminaryScore: 70 }])).toHaveLength(1);
    expect(deduplicateCandidates([base, { ...base, preliminaryScore: 70 }])[0].preliminaryScore).toBe(70);
  });

  it("classifies the article itself instead of copying a publisher-wide section list", () => {
    expect(classifyArticle("NASA prepares a lunar telescope mission")).toEqual({ category: "science", topic: "aerospace" });
    expect(classifyArticle("New AI model changes software development")).toEqual({ category: "ai", topic: "artificial-intelligence" });
    expect(classifyArticle("Major game studio closes after publisher restructuring")).toEqual({ category: "games", topic: "game-development" });
    expect(classifyArticle("Country music icon dies at 80")).toEqual({ category: "entertainment", topic: "music-entertainment" });
    expect(classifyArticle("CIA director visits Moscow").category).not.toBe("entertainment");
    expect(classifyArticle("NASA welcomes a new contractor").category).not.toBe("entertainment");
    expect(classifyArticle("Malaria cluster investigated at airport")).toEqual({ category: "health", topic: "health-medicine" });
    expect(classifyArticle("Rental insecurity affects more children")).toEqual({ category: "society", topic: "public-policy" });
  });

  it("rejects sponsored content and routine leisure reviews or rumours", () => {
    expect(isExcludedCandidate({ title: "Sponsored: a new AI platform", url: "https://example.com/sponsor/ai" })).toBe(true);
    expect(isExcludedCandidate({ title: "Our review of the newest video game", url: "https://example.com/games/review" })).toBe(true);
    expect(isExcludedCandidate({ title: "MSI Stealth 16 AI laptop review", url: "https://example.com/hardware/review" })).toBe(true);
    expect(isExcludedCandidate({ title: "Studio responds to game leak", url: "https://example.com/games/leak" })).toBe(true);
    expect(isExcludedCandidate({ title: "Film studio announces a binding merger", url: "https://example.com/business/merger" })).toBe(false);
  });

  it("round-robins categories and enforces per-publisher candidate ceilings", () => {
    const make = (sourceId: string, sourceType: RawCandidate["sourceType"], index: number, category: RawCandidate["categoryHints"][number]): RawCandidate => ({
      id: `${sourceId}-${String(index).padStart(6, "0")}`,
      title: `${sourceId} item ${index}`,
      url: `https://${sourceId}.example/item-${index}`,
      canonicalUrl: `https://${sourceId}.example/item-${index}`,
      sourceId,
      sourceName: sourceId,
      domain: `${sourceId}.example`,
      sourceType,
      sourceTier: sourceType === "primary" ? "A" : "B",
      language: "en",
      publishedAt: "2026-08-25T02:00:00Z",
      discovery: "rss",
      categoryHints: [category],
      topic: category === "science" ? "life-sciences" : "general",
      preliminaryScore: 90 - index
    });
    const pool = [
      ...Array.from({ length: 20 }, (_, index) => make("bbc", "independent-media", index, "world")),
      ...Array.from({ length: 10 }, (_, index) => make("nasa", "primary", index, "science")),
      ...Array.from({ length: 10 }, (_, index) => make("xinhua", "state-media", index, "society"))
    ];
    const selected = selectBalanced(pool);
    expect(selected.filter((item) => item.sourceId === "bbc")).toHaveLength(12);
    expect(selected.filter((item) => item.sourceId === "nasa")).toHaveLength(6);
    expect(selected.filter((item) => item.sourceId === "xinhua")).toHaveLength(4);
    expect(selected.slice(0, 3).map((item) => item.categoryHints[0])).toEqual(["world", "science", "society"]);
  });
});
