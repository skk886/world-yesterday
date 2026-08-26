import { createHash } from "node:crypto";
import type { RawCandidate } from "../../src/lib/schema";

const trackingParameters = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "cmpid"
]);

const stopWords = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "from", "at", "by", "as", "is", "are", "was", "were", "after", "new", "says"]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameters.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return url.toString();
}

export function stableCandidateId(url: string): string {
  return createHash("sha256").update(canonicalizeUrl(url)).digest("hex").slice(0, 16);
}

function titleTokens(title: string): Set<string> {
  const normalized = title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const latin = normalized.split(" ").filter((word) => word.length > 2 && !stopWords.has(word));
  const cjk = [...normalized.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "")];
  const bigrams = cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`);
  return new Set([...latin, ...bigrams]);
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

export function deduplicateCandidates(candidates: RawCandidate[]): RawCandidate[] {
  const byUrl = new Map<string, RawCandidate>();
  for (const candidate of candidates) {
    const current = byUrl.get(candidate.canonicalUrl);
    if (!current || candidate.preliminaryScore > current.preliminaryScore) {
      byUrl.set(candidate.canonicalUrl, candidate);
    }
  }

  const sorted = [...byUrl.values()].sort((a, b) => b.preliminaryScore - a.preliminaryScore);
  const clusters: RawCandidate[][] = [];
  for (const candidate of sorted) {
    const cluster = clusters.find((items) => titleSimilarity(items[0].title, candidate.title) >= 0.72);
    if (cluster) cluster.push(candidate);
    else clusters.push([candidate]);
  }

  return clusters
    .flatMap((cluster) => {
      const uniqueDomains = new Set(cluster.map((item) => item.domain)).size;
      return cluster.map((item) => ({
        ...item,
        preliminaryScore: Math.min(100, item.preliminaryScore + Math.min(25, (uniqueDomains - 1) * 7))
      }));
    })
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore || b.publishedAt.localeCompare(a.publishedAt));
}
