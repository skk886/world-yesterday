import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { categoryTargets, editionSchema, journalIds, rawSnapshotSchema, type Edition, type RawSnapshot } from "../src/lib/schema";
import { dateIsInShanghaiDay } from "../src/lib/dates";
import { findAllowedSource, loadSourceRegistry, normalizeDomain, sourceIndependenceKey } from "./lib/sources";
import { compareEditorialRank, computeImportanceScore, diversityErrors, normalizeOrganizationId } from "./lib/editorial";
import { canonicalizeUrl } from "./lib/candidates";
import { extractDoi, normalizeDoi } from "./lib/crossref";

export type ValidationResult = { valid: boolean; errors: string[] };

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function validateEditionSemantics(edition: Edition): ValidationResult {
  const errors: string[] = [];
  const sources = loadSourceRegistry();
  const ids = new Set<string>();
  const ranks = new Set<number>();
  const pending = edition.items.filter((item) => item.verificationStatus === "pending");
  const verified = edition.items.filter((item) => item.verificationStatus === "verified");
  const selectedJournalHighlights = edition.schemaVersion === 4
    ? edition.journalHighlights.filter((highlight) => highlight.status === "selected")
    : [];

  if (pending.length > 15) errors.push(`Single-source items exceed limit: ${pending.length}/15.`);
  if (edition.metrics.pendingCount !== pending.length) errors.push("metrics.pendingCount does not match items.");
  if (edition.metrics.verifiedCount !== verified.length) errors.push("metrics.verifiedCount does not match items.");
  if (edition.metrics.rejectedCount !== Math.max(0, edition.metrics.candidateCount - edition.items.length - selectedJournalHighlights.length)) errors.push("metrics.rejectedCount does not match candidates minus published items and journal highlights.");
  if (edition.status === "complete" && edition.items.length !== 30) errors.push("A complete edition must contain exactly 30 items.");
  if (edition.status === "partial" && edition.items.length === 30) errors.push("A 30-item edition must use complete status.");
  if (pending.length && verified.length && Math.min(...pending.map((item) => item.rank)) <= Math.max(...verified.map((item) => item.rank))) {
    errors.push("Pending observations must rank after every verified item.");
  }
  for (const category of ["ai", "business", "health", "climate", "entertainment", "games", "culture-sports"] as const) {
    const count = edition.items.filter((item) => item.category === category).length;
    if (count > categoryTargets[category]) errors.push(`${category} exceeds its target; transferred vacancies may only go to world, technology, science, or society.`);
  }
  errors.push(...diversityErrors(edition));

  const tokenUsage = edition.metrics.tokenUsage;
  if (tokenUsage.input + tokenUsage.output !== tokenUsage.total) errors.push("Token input + output must equal total.");

  if (edition.schemaVersion === 4) {
    const journalNames = { science: "Science", nature: "Nature" } as const;
    const journalSlots = new Set(edition.journalHighlights.map((highlight) => highlight.journal));
    for (const journal of journalIds) {
      if (!journalSlots.has(journal)) errors.push(`Missing journal highlight slot: ${journal}.`);
    }
    if (journalSlots.size !== 2) errors.push("Journal highlight slots must contain Science and Nature exactly once.");

    const itemUrls = new Set<string>();
    const itemDois = new Set<string>();
    for (const item of edition.items) {
      for (const source of item.sources) {
        try { itemUrls.add(canonicalizeUrl(source.url)); } catch { /* URL shape is validated by Zod. */ }
        const doi = extractDoi(source.url);
        if (doi) itemDois.add(doi);
      }
    }

    for (const highlight of edition.journalHighlights) {
      if (highlight.journalName !== journalNames[highlight.journal]) errors.push(`${highlight.journal}: journalName is inconsistent.`);
      if (highlight.status === "selected") {
        const required = [
          highlight.candidateId,
          highlight.originalTitle,
          highlight.titles?.zh,
          highlight.titles?.en,
          highlight.summaries?.zh,
          highlight.summaries?.en,
          highlight.whyItMatters?.zh,
          highlight.whyItMatters?.en,
          highlight.topic,
          highlight.url,
          highlight.publishedAt,
          highlight.metadataSource
        ];
        if (required.some((value) => !value)) errors.push(`${highlight.journal}: selected journal highlight is missing required fields.`);
        if (highlight.publishedAt && !dateIsInShanghaiDay(highlight.publishedAt, edition.date)) errors.push(`${highlight.journal}: selected highlight is outside ${edition.date}.`);
        if (highlight.url) {
          const source = findAllowedSource(highlight.url, sources);
          if (source?.id !== highlight.journal) errors.push(`${highlight.journal}: highlight URL does not belong to the matching allowlisted journal.`);
          try {
            if (itemUrls.has(canonicalizeUrl(highlight.url))) errors.push(`${highlight.journal}: journal highlight duplicates a ranked item URL.`);
          } catch { /* URL shape is validated by Zod. */ }
        }
        const doi = extractDoi(highlight.doi, highlight.url);
        if (doi && itemDois.has(doi)) errors.push(`${highlight.journal}: journal highlight duplicates a ranked item DOI.`);
        if (highlight.journal === "science") {
          if (!highlight.doi || !doi || normalizeDoi(highlight.doi) !== doi) errors.push("science: a selected highlight requires a normalized DOI.");
          if (highlight.metadataSource !== "crossref") errors.push("science: selected highlight metadataSource must be crossref.");
        }
        if (highlight.journal === "nature" && highlight.metadataSource !== "rss") errors.push("nature: selected highlight metadataSource must be rss.");
        if (highlight.summaries) {
          if (highlight.summaries.zh.length < 30 || highlight.summaries.zh.length > 160) errors.push(`${highlight.journal}: Chinese journal summary should be 30-160 characters.`);
          const englishWords = wordCount(highlight.summaries.en);
          if (englishWords < 25 || englishWords > 130) errors.push(`${highlight.journal}: English journal summary should be 25-130 words.`);
        }
      } else if (highlight.status === "no-update" && (highlight.candidateId || highlight.publishedAt)) {
        errors.push(`${highlight.journal}: no-update slot cannot identify a published candidate.`);
      }
    }
  }

  for (const item of edition.items) {
    if (ids.has(item.id)) errors.push(`Duplicate item id: ${item.id}.`);
    if (ranks.has(item.rank)) errors.push(`Duplicate rank: ${item.rank}.`);
    ids.add(item.id);
    ranks.add(item.rank);

    const computedScore = computeImportanceScore(item.importanceFactors);
    if (item.impactScore !== computedScore) errors.push(`${item.id}: impactScore ${item.impactScore} does not match controller score ${computedScore}.`);
    if (item.subjectOrganization && item.subjectOrganization.id !== normalizeOrganizationId(item.subjectOrganization.id)) {
      errors.push(`${item.id}: subjectOrganization.id is not normalized.`);
    }

    if (item.verificationStatus === "pending" && !item.pendingReason) errors.push(`${item.id}: pendingReason is required.`);
    if (item.verificationStatus === "verified" && item.pendingReason) errors.push(`${item.id}: verified item cannot have pendingReason.`);
    if (item.summaries.zh.length < 40 || item.summaries.zh.length > 140) errors.push(`${item.id}: Chinese summary should be 40-140 characters.`);
    const englishWords = wordCount(item.summaries.en);
    if (englishWords < 35 || englishWords > 130) errors.push(`${item.id}: English summary should be 35-130 words.`);

    const independentGroups = new Set<string>();
    let primaryCount = 0;
    let hasDateEvidence = false;
    let hasIndependent = false;
    for (const citation of item.sources) {
      const source = findAllowedSource(citation.url, sources);
      if (!source) {
        errors.push(`${item.id}: source is outside the allowlist: ${citation.url}`);
        continue;
      }
      if (citation.name !== source.name) errors.push(`${item.id}: citation name does not match registry for ${citation.url}.`);
      const actualDomain = normalizeDomain(new URL(citation.url).hostname);
      if (normalizeDomain(citation.domain) !== actualDomain) errors.push(`${item.id}: citation domain does not match URL: ${citation.domain}.`);
      if (citation.type !== source.type) errors.push(`${item.id}: source type mismatch for ${citation.url}.`);
      const independenceKey = sourceIndependenceKey(citation.url, sources);
      if (independenceKey) independentGroups.add(independenceKey);
      if (source.type === "primary") primaryCount += 1;
      if (source.type === "independent-media") hasIndependent = true;
      if (dateIsInShanghaiDay(citation.publishedAt, edition.date)
        || Boolean(citation.updatedAt && dateIsInShanghaiDay(citation.updatedAt, edition.date))) hasDateEvidence = true;
    }
    if (!hasDateEvidence) errors.push(`${item.id}: no source was published or materially updated on ${edition.date}.`);
    if (item.verificationStatus === "verified" && independentGroups.size < 2 && primaryCount < 1) {
      errors.push(`${item.id}: verified item needs two independent publisher groups or one primary source.`);
    }
    if (item.verificationStatus === "verified" && item.sources.every((source) => source.type === "state-media")) {
      errors.push(`${item.id}: state-media-only evidence cannot be verified.`);
    }
    if (item.verificationStatus === "verified" && item.sources.some((source) => source.type === "state-media") && !hasIndependent && primaryCount === 0) {
      errors.push(`${item.id}: a state-media claim needs independent or primary corroboration.`);
    }
    if (item.verificationStatus === "pending" && !hasIndependent && primaryCount === 0) {
      errors.push(`${item.id}: a single-source item needs at least one independent-media or primary source.`);
    }
  }

  const sortedRanks = [...ranks].sort((a, b) => a - b);
  if (sortedRanks.some((rank, index) => rank !== index + 1)) errors.push("Ranks must be contiguous from 1.");
  const rankedItems = [...edition.items].sort((a, b) => a.rank - b.rank);
  if (rankedItems.some((item, index) => index > 0 && compareEditorialRank(rankedItems[index - 1], item) > 0)) {
    errors.push("Items do not follow verified, score, independent-source, and cross-region ranking order.");
  }
  return { valid: errors.length === 0, errors };
}

export function validateRawSnapshotSemantics(snapshot: RawSnapshot): ValidationResult {
  const errors: string[] = [];
  const sources = loadSourceRegistry();
  for (const candidate of snapshot.candidates) {
    const source = findAllowedSource(candidate.canonicalUrl, sources);
    if (!source) {
      errors.push(`${candidate.id}: raw candidate is outside the allowlist.`);
      continue;
    }
    if (candidate.sourceId !== source.id || candidate.sourceType !== source.type || candidate.sourceTier !== source.tier) {
      errors.push(`${candidate.id}: raw source metadata does not match the registry.`);
    }
    if (normalizeDomain(candidate.domain) !== normalizeDomain(new URL(candidate.canonicalUrl).hostname)) {
      errors.push(`${candidate.id}: raw candidate domain does not match canonicalUrl.`);
    }
    if (!dateIsInShanghaiDay(candidate.publishedAt, snapshot.date)
      && !(candidate.updatedAt && dateIsInShanghaiDay(candidate.updatedAt, snapshot.date))) {
      errors.push(`${candidate.id}: raw candidate is outside ${snapshot.date}.`);
    }
    if (candidate.metadataEnrichment) {
      const doi = extractDoi(candidate.doi, candidate.url, candidate.canonicalUrl);
      if (candidate.sourceId !== "science") errors.push(`${candidate.id}: Crossref enrichment is only allowed for Science RSS candidates.`);
      if (!doi || normalizeDoi(candidate.metadataEnrichment.doi) !== doi) errors.push(`${candidate.id}: Crossref DOI does not match the candidate DOI.`);
      if (candidate.metadataEnrichment.status === "enriched" && candidate.description !== candidate.metadataEnrichment.abstract) {
        errors.push(`${candidate.id}: enriched Science description must equal the sanitized Crossref abstract.`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function loadAndValidateEdition(filePath: string): Edition {
  const edition = editionSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  const semantic = validateEditionSemantics(edition);
  if (!semantic.valid) throw new Error(semantic.errors.join("\n"));
  return edition;
}

function validateDirectory(directory: string, schema: "edition" | "raw") {
  if (!fs.existsSync(directory)) return [];
  const errors: string[] = [];
  for (const name of fs.readdirSync(directory).filter((value) => /^\d{4}-\d{2}-\d{2}\.json$/.test(value))) {
    const filePath = path.join(directory, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (schema === "edition") {
        const edition = editionSchema.parse(parsed);
        if (edition.date !== name.replace(".json", "")) throw new Error("Filename and edition date differ.");
        const semantic = validateEditionSemantics(edition);
        if (!semantic.valid) throw new Error(semantic.errors.join("\n"));
      } else {
        const raw = rawSnapshotSchema.parse(parsed);
        if (raw.date !== name.replace(".json", "")) throw new Error("Filename and raw snapshot date differ.");
        const semantic = validateRawSnapshotSemantics(raw);
        if (!semantic.valid) throw new Error(semantic.errors.join("\n"));
      }
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = [
    ...validateDirectory(path.resolve("data/editions"), "edition"),
    ...validateDirectory(path.resolve("data/raw"), "raw")
  ];
  if (errors.length) {
    console.error(errors.join("\n\n"));
    process.exitCode = 1;
  } else {
    console.log("All published editions and raw snapshots are valid.");
  }
}
