import type { RawCandidate } from "../../src/lib/schema";

export const journalSourceIds = ["science", "nature"] as const;
export type JournalSourceId = (typeof journalSourceIds)[number];

const excludedJournalTitles = [
  /^correction\b/i,
  /^erratum\b/i,
  /^retraction\b/i,
  /^editorial\b/i,
  /^table of contents\b/i,
  /^this week in science\b/i,
  /^books?\b/i,
  /book review/i,
  /publisher correction/i,
  /author correction/i
];

export function isJournalSourceId(value: string): value is JournalSourceId {
  return journalSourceIds.includes(value as JournalSourceId);
}

export function isExcludedJournalCandidate(candidate: RawCandidate): boolean {
  const contentType = candidate.journalContentType?.toLowerCase() ?? "";
  return excludedJournalTitles.some((pattern) => pattern.test(candidate.title))
    || /correction|erratum|retraction|table of contents|book review/.test(contentType);
}

export function hasMeaningfulJournalDescription(candidate: RawCandidate): boolean {
  const description = candidate.description?.replace(/\s+/g, " ").trim() ?? "";
  if (candidate.sourceId === "science") {
    return candidate.metadataEnrichment?.status === "enriched"
      && Boolean(candidate.metadataEnrichment.abstract)
      && description.length >= 80;
  }
  if (candidate.sourceId === "nature") {
    return description.length >= 80
      && !/^Nature(?:,|\s+Volume\b)/i.test(description);
  }
  return false;
}

export function isJournalHighlightEligible(candidate: RawCandidate): boolean {
  return isJournalSourceId(candidate.sourceId)
    && !isExcludedJournalCandidate(candidate)
    && hasMeaningfulJournalDescription(candidate);
}

function journalPriority(candidate: RawCandidate): number {
  return (isJournalHighlightEligible(candidate) ? 1_000 : 0)
    + candidate.preliminaryScore
    + Math.min(25, Math.floor((candidate.description?.length ?? 0) / 160));
}

export function selectJournalReserves(candidates: RawCandidate[], perJournal = 4): RawCandidate[] {
  const ranked = new Map(journalSourceIds.map((sourceId) => [sourceId, candidates
    .filter((candidate) => candidate.sourceId === sourceId && !isExcludedJournalCandidate(candidate))
    .sort((left, right) => journalPriority(right) - journalPriority(left) || left.id.localeCompare(right.id))
    .slice(0, perJournal)]));
  const selected: RawCandidate[] = [];
  for (let index = 0; index < perJournal; index += 1) {
    for (const sourceId of journalSourceIds) {
      const candidate = ranked.get(sourceId)?.[index];
      if (candidate) selected.push(candidate);
    }
  }
  return selected;
}
