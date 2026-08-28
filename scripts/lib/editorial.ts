import { categoryTargets, importanceWeights, type Edition, type NewsItem } from "../../src/lib/schema";
import { loadSourceRegistry, sourceIndependenceKey } from "./sources";
import { canonicalizeUrl } from "./candidates";
import { extractDoi } from "./crossref";

const sourceRegistry = loadSourceRegistry();

export function normalizeOrganizationId(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

export function computeImportanceScore(factors: NewsItem["importanceFactors"]): number {
  const weighted =
    factors.impactBreadth * importanceWeights.impactBreadth +
    factors.consequenceSeverity * importanceWeights.consequenceSeverity +
    factors.systemicSignificance * importanceWeights.systemicSignificance +
    factors.independentCoverage * importanceWeights.independentCoverage +
    factors.yesterdayNovelty * importanceWeights.yesterdayNovelty;
  return Math.max(0, Math.min(100, Math.round(weighted)));
}

function organizationKeys(item: NewsItem): string[] {
  const keys = new Set<string>();
  if (item.subjectOrganization) keys.add(normalizeOrganizationId(item.subjectOrganization.id));
  return [...keys];
}

function normalizeItem(item: NewsItem): NewsItem {
  const subjectOrganization = item.subjectOrganization
    ? { id: normalizeOrganizationId(item.subjectOrganization.id), name: item.subjectOrganization.name.trim() }
    : null;
  return { ...item, subjectOrganization, impactScore: computeImportanceScore(item.importanceFactors) };
}

function independentSourceCount(item: NewsItem): number {
  return new Set(item.sources
    .map((source) => sourceIndependenceKey(source.url, sourceRegistry))
    .filter((group): group is string => Boolean(group))).size;
}

export function compareEditorialRank(left: NewsItem, right: NewsItem): number {
  if (left.verificationStatus !== right.verificationStatus) return left.verificationStatus === "verified" ? -1 : 1;
  return right.impactScore - left.impactScore
    || independentSourceCount(right) - independentSourceCount(left)
    || right.regions.length - left.regions.length
    || left.id.localeCompare(right.id);
}

export function applyEditorialControls(edition: Edition): Edition {
  const sorted = edition.items.map(normalizeItem).sort(compareEditorialRank);
  const journalHighlights = edition.schemaVersion === 4
    ? edition.journalHighlights.filter((highlight) => highlight.status === "selected")
    : [];
  const highlightedCandidateIds = new Set(journalHighlights.map((highlight) => highlight.candidateId).filter(Boolean));
  const highlightedUrls = new Set(journalHighlights.map((highlight) => {
    try { return highlight.url ? canonicalizeUrl(highlight.url) : undefined; } catch { return undefined; }
  }).filter((value): value is string => Boolean(value)));
  const highlightedDois = new Set(journalHighlights.map((highlight) => extractDoi(highlight.doi, highlight.url)).filter((value): value is string => Boolean(value)));
  const selected: NewsItem[] = [];
  const organizationTotals = new Map<string, number>();
  const organizationCategories = new Map<string, number>();
  const limitedCategoryCounts = new Map<string, number>();
  let scienceTechnologyAerospace = 0;

  for (const item of sorted) {
    if (selected.length >= 30) break;
    const duplicatesHighlight = highlightedCandidateIds.has(item.id)
      || item.sources.some((source) => {
        let canonicalUrl: string | undefined;
        try { canonicalUrl = canonicalizeUrl(source.url); } catch { /* Validation reports malformed URLs. */ }
        const doi = extractDoi(source.url);
        return Boolean((canonicalUrl && highlightedUrls.has(canonicalUrl)) || (doi && highlightedDois.has(doi)));
      });
    if (duplicatesHighlight) continue;
    const keys = organizationKeys(item);
    if (keys.some((key) => (organizationTotals.get(key) ?? 0) >= 2)) continue;
    if (keys.some((key) => (organizationCategories.get(`${key}:${item.category}`) ?? 0) >= 1)) continue;
    if (item.topic === "aerospace" && ["science", "technology"].includes(item.category) && scienceTechnologyAerospace >= 3) continue;
    if (["ai", "business", "health", "climate", "entertainment", "games", "culture-sports"].includes(item.category)) {
      const count = limitedCategoryCounts.get(item.category) ?? 0;
      if (count >= categoryTargets[item.category]) continue;
      limitedCategoryCounts.set(item.category, count + 1);
    }

    selected.push(item);
    for (const key of keys) {
      organizationTotals.set(key, (organizationTotals.get(key) ?? 0) + 1);
      const categoryKey = `${key}:${item.category}`;
      organizationCategories.set(categoryKey, (organizationCategories.get(categoryKey) ?? 0) + 1);
    }
    if (item.topic === "aerospace" && ["science", "technology"].includes(item.category)) scienceTechnologyAerospace += 1;
  }

  const items = selected.map((item, index) => ({ ...item, rank: index + 1 }));
  return {
    ...edition,
    status: items.length === 30 ? "complete" : "partial",
    items
  };
}

export function diversityErrors(edition: Edition): string[] {
  const errors: string[] = [];
  const organizationTotals = new Map<string, number>();
  const organizationCategories = new Map<string, number>();
  let scienceTechnologyAerospace = 0;

  for (const item of edition.items) {
    for (const key of organizationKeys(item)) {
      organizationTotals.set(key, (organizationTotals.get(key) ?? 0) + 1);
      const categoryKey = `${key}:${item.category}`;
      organizationCategories.set(categoryKey, (organizationCategories.get(categoryKey) ?? 0) + 1);
    }
    if (item.topic === "aerospace" && ["science", "technology"].includes(item.category)) scienceTechnologyAerospace += 1;
  }

  for (const [organization, count] of organizationTotals) {
    if (count > 2) errors.push(`${organization}: organization exceeds edition limit: ${count}/2.`);
  }
  for (const [key, count] of organizationCategories) {
    if (count > 1) errors.push(`${key}: organization exceeds same-category limit: ${count}/1.`);
  }
  if (scienceTechnologyAerospace > 3) errors.push(`Science/technology aerospace items exceed limit: ${scienceTechnologyAerospace}/3.`);
  const aiOrganizationCounts = new Map<string, number>();
  for (const item of edition.items.filter((candidate) => candidate.category === "ai")) {
    for (const key of organizationKeys(item)) aiOrganizationCounts.set(key, (aiOrganizationCounts.get(key) ?? 0) + 1);
  }
  for (const [organization, count] of aiOrganizationCounts) {
    if (count > 1) errors.push(`${organization}: AI company exceeds issue limit: ${count}/1.`);
  }
  return errors;
}
