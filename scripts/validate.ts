import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { categoryTargets, editionSchema, rawSnapshotSchema, type Edition, type RawSnapshot } from "../src/lib/schema";
import { dateIsInShanghaiDay } from "../src/lib/dates";
import { findAllowedSource, loadSourceRegistry, normalizeDomain } from "./lib/sources";
import { compareEditorialRank, computeImportanceScore, diversityErrors, normalizeOrganizationId } from "./lib/editorial";

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

  if (pending.length > 5) errors.push(`Pending items exceed limit: ${pending.length}/5.`);
  if (edition.metrics.pendingCount !== pending.length) errors.push("metrics.pendingCount does not match items.");
  if (edition.metrics.verifiedCount !== verified.length) errors.push("metrics.verifiedCount does not match items.");
  if (edition.metrics.rejectedCount !== Math.max(0, edition.metrics.candidateCount - edition.items.length)) errors.push("metrics.rejectedCount does not match candidates minus published items.");
  if (edition.status === "complete" && edition.items.length !== 30) errors.push("A complete edition must contain exactly 30 items.");
  if (edition.status === "partial" && edition.items.length === 30) errors.push("A 30-item edition must use complete status.");
  if (pending.length && verified.length && Math.min(...pending.map((item) => item.rank)) <= Math.max(...verified.map((item) => item.rank))) {
    errors.push("Pending observations must rank after every verified item.");
  }
  for (const category of ["business", "health", "climate", "culture-sports"] as const) {
    const count = edition.items.filter((item) => item.category === category).length;
    if (count > categoryTargets[category]) errors.push(`${category} exceeds its target; transferred vacancies may only go to world, technology, science, or society.`);
  }
  errors.push(...diversityErrors(edition));

  const tokenUsage = edition.metrics.tokenUsage;
  if (tokenUsage.input + tokenUsage.output !== tokenUsage.total) errors.push("Token input + output must equal total.");

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

    const uniqueDomains = new Set<string>();
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
      uniqueDomains.add(source.domain);
      if (source.type === "primary") primaryCount += 1;
      if (source.type === "independent-media") hasIndependent = true;
      if (dateIsInShanghaiDay(citation.updatedAt ?? citation.publishedAt, edition.date)) hasDateEvidence = true;
    }
    if (!hasDateEvidence) errors.push(`${item.id}: no source was published or materially updated on ${edition.date}.`);
    if (item.verificationStatus === "verified" && uniqueDomains.size < 2 && primaryCount < 1) {
      errors.push(`${item.id}: verified item needs two independent domains or one primary source.`);
    }
    if (item.verificationStatus === "verified" && item.sources.every((source) => source.type === "state-media")) {
      errors.push(`${item.id}: state-media-only evidence cannot be verified.`);
    }
    if (item.verificationStatus === "verified" && item.sources.some((source) => source.type === "state-media") && !hasIndependent && primaryCount === 0) {
      errors.push(`${item.id}: a state-media claim needs independent or primary corroboration.`);
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
    if (!dateIsInShanghaiDay(candidate.updatedAt ?? candidate.publishedAt, snapshot.date)) {
      errors.push(`${candidate.id}: raw candidate is outside ${snapshot.date}.`);
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
