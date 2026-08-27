import { createHash } from "node:crypto";
import type { Category, RawCandidate } from "../../src/lib/schema";

export type ArticleClassification = { category: Category; topic: RawCandidate["topic"] };

const topicRules: Array<{ topic: RawCandidate["topic"]; category: Category; patterns: RegExp[] }> = [
  { topic: "aerospace", category: "science", patterns: [/\bnasa\b/i, /\besa\b/i, /spacecraft/i, /space telescope/i, /\bastronaut/i, /\borbit/i, /\blunar/i, /\bmoon\b/i, /\bmars\b/i, /\basteroid/i, /rocket launch/i, /space mission/i, /satellite launch/i] },
  { topic: "artificial-intelligence", category: "technology", patterns: [/artificial intelligence/i, /\bai\b/i, /machine learning/i, /large language model/i, /chatbot/i, /deepfake/i] },
  { topic: "health-medicine", category: "health", patterns: [/health/i, /medical/i, /medicine/i, /disease/i, /virus/i, /vaccine/i, /cancer/i, /malaria/i, /hospital/i, /patient/i, /outbreak/i, /infection/i] },
  { topic: "climate-environment", category: "climate", patterns: [/climate/i, /global warming/i, /greenhouse/i, /carbon emission/i, /extreme heat/i, /wildfire/i, /drought/i, /flood/i, /biodiversity/i, /pollution/i] },
  { topic: "earth-science", category: "science", patterns: [/earthquake/i, /volcan/i, /geolog/i, /ocean temperature/i, /sea level/i, /atmospher/i, /meteorolog/i, /palaeontolog/i, /paleontolog/i] },
  { topic: "life-sciences", category: "science", patterns: [/biology/i, /genom/i, /\bdna\b/i, /evolution/i, /species/i, /fossil/i, /neuroscien/i, /microbi/i, /cellular/i, /ecology/i] },
  { topic: "energy-materials", category: "technology", patterns: [/battery/i, /semiconductor/i, /solar power/i, /wind power/i, /nuclear fusion/i, /nuclear energy/i, /hydrogen/i, /material science/i, /chemistry/i, /energy storage/i] },
  { topic: "digital-infrastructure", category: "technology", patterns: [/cyber/i, /software/i, /computer/i, /internet/i, /data cent/i, /digital/i, /robot/i, /quantum comput/i, /chipmaker/i, /technology/i] },
  { topic: "economy-finance", category: "business", patterns: [/econom/i, /inflation/i, /interest rate/i, /trade deal/i, /tariff/i, /market/i, /bank/i, /investment/i, /company/i, /business/i, /stock/i] },
  { topic: "conflict-security", category: "world", patterns: [/\bwar\b/i, /attack/i, /military/i, /missile/i, /ceasefire/i, /conflict/i, /\bsecurity\b/i, /hostage/i, /sanction/i, /diplomat/i] },
  { topic: "culture-sports", category: "culture-sports", patterns: [/sport/i, /football/i, /soccer/i, /olympic/i, /tennis/i, /film/i, /music/i, /museum/i, /artist/i, /literature/i, /culture/i] },
  { topic: "public-policy", category: "society", patterns: [/election/i, /government/i, /court/i, /law\b/i, /policy/i, /school/i, /housing/i, /rental/i, /insecurity/i, /migration/i, /protest/i, /rights/i, /police/i, /parliament/i] }
];

export function classifyArticle(title: string, description = ""): ArticleClassification {
  const text = `${title} ${description}`.normalize("NFKC");
  let best: { rule: (typeof topicRules)[number]; score: number; order: number } | undefined;
  topicRules.forEach((rule, order) => {
    const score = rule.patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && order < best.order))) best = { rule, score, order };
  });
  if (best) return { category: best.rule.category, topic: best.rule.topic };
  return { category: "world", topic: "general" };
}

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
