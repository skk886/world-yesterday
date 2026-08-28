import fs from "node:fs";
import path from "node:path";
import type { RawCandidate } from "../../src/lib/schema";

type Enrichment = NonNullable<RawCandidate["metadataEnrichment"]>;
type CrossrefWork = { DOI?: string; abstract?: string; URL?: string };
type CrossrefResponse = { status?: string; message?: CrossrefWork };

export type CrossrefOptions = {
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  attempts?: number;
  cachePath?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
};

export type CrossrefSummary = {
  attempted: number;
  enriched: number;
  abstractMissing: number;
  notFound: number;
  failed: number;
  noDoi: number;
};

const doiPattern = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;

export function normalizeDoi(value: string): string {
  return value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;]+$/g, "")
    .toLowerCase();
}

export function extractDoi(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) continue;
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* Use the original value. */ }
    const match = decoded.match(doiPattern)?.[0];
    if (match) return normalizeDoi(match);
  }
  return undefined;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "
  };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

export function cleanCrossrefAbstract(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*abstract\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
  return cleaned.length >= 80 ? cleaned : undefined;
}

function loadCache(cachePath: string | undefined): Record<string, Enrichment> {
  if (!cachePath || !fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, Enrichment>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value?.provider === "crossref"));
  } catch {
    return {};
  }
}

function saveCache(cachePath: string | undefined, cache: Record<string, Enrichment>) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  if (fs.existsSync(cachePath)) {
    fs.copyFileSync(temporaryPath, cachePath);
    fs.rmSync(temporaryPath, { force: true });
  } else {
    fs.renameSync(temporaryPath, cachePath);
  }
}

async function fetchCrossrefWork(doi: string, options: Required<Pick<CrossrefOptions, "timeoutMs" | "attempts">> & Pick<CrossrefOptions, "fetcher" | "now">): Promise<Enrichment> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const sourceUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  let lastError = "Crossref request failed.";

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await fetcher(sourceUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "WorldYesterday/0.2 (+https://github.com/skk886/world-yesterday; Crossref metadata enrichment)"
        },
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      const fetchedAt = now().toISOString();
      if (response.status === 404) return { provider: "crossref", status: "not-found", doi, fetchedAt, sourceUrl };
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = await response.json() as CrossrefResponse;
      const returnedDoi = payload.message?.DOI ? normalizeDoi(payload.message.DOI) : undefined;
      if (returnedDoi !== doi) {
        return {
          provider: "crossref",
          status: "error",
          doi,
          fetchedAt,
          sourceUrl,
          error: `DOI mismatch: requested ${doi}, received ${returnedDoi ?? "none"}.`
        };
      }
      const abstract = cleanCrossrefAbstract(payload.message?.abstract);
      return abstract
        ? { provider: "crossref", status: "enriched", doi, fetchedAt, abstract, sourceUrl }
        : { provider: "crossref", status: "abstract-missing", doi, fetchedAt, sourceUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    provider: "crossref",
    status: "error",
    doi,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceUrl,
    error: lastError.slice(0, 500)
  };
}

async function mapWithConcurrency<T>(values: string[], concurrency: number, operation: (value: string) => Promise<T>): Promise<Map<string, T>> {
  const output = new Map<string, T>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      output.set(value, await operation(value));
    }
  });
  await Promise.all(workers);
  return output;
}

export async function enrichScienceCandidates(candidates: RawCandidate[], options: CrossrefOptions = {}): Promise<{ candidates: RawCandidate[]; summary: CrossrefSummary }> {
  const limit = options.limit ?? 40;
  const concurrency = options.concurrency ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const attempts = options.attempts ?? 2;
  const cache = loadCache(options.cachePath);
  const science = candidates.filter((candidate) => candidate.sourceId === "science" && candidate.discovery === "rss");
  const noDoi = science.filter((candidate) => !extractDoi(candidate.doi, candidate.url, candidate.canonicalUrl)).length;
  const dois = [...new Set(science
    .map((candidate) => extractDoi(candidate.doi, candidate.url, candidate.canonicalUrl))
    .filter((doi): doi is string => Boolean(doi)))]
    .slice(0, limit);

  const uncached = dois.filter((doi) => !cache[doi] || cache[doi].status === "error");
  const fetched = await mapWithConcurrency(uncached, concurrency, (doi) => fetchCrossrefWork(doi, {
    timeoutMs,
    attempts,
    fetcher: options.fetcher,
    now: options.now
  }));
  for (const [doi, enrichment] of fetched) {
    if (enrichment.status !== "error") cache[doi] = enrichment;
  }
  saveCache(options.cachePath, cache);

  const lookup = new Map<string, Enrichment>();
  for (const doi of dois) {
    const enrichment = fetched.get(doi) ?? cache[doi];
    if (enrichment) lookup.set(doi, enrichment);
  }
  const enrichedCandidates = candidates.map((candidate) => {
    if (candidate.sourceId !== "science" || candidate.discovery !== "rss") return candidate;
    const doi = extractDoi(candidate.doi, candidate.url, candidate.canonicalUrl);
    const metadataEnrichment = doi ? lookup.get(doi) ?? candidate.metadataEnrichment : candidate.metadataEnrichment;
    if (!doi || !metadataEnrichment) return { ...candidate, ...(doi ? { doi } : {}) };
    return {
      ...candidate,
      doi,
      rssDescription: candidate.rssDescription ?? candidate.description,
      description: metadataEnrichment.status === "enriched" ? metadataEnrichment.abstract : candidate.description,
      metadataEnrichment,
      preliminaryScore: metadataEnrichment.status === "enriched"
        ? Math.min(100, candidate.preliminaryScore + 8)
        : candidate.preliminaryScore
    };
  });

  const statuses = [...lookup.values()].map((value) => value.status);
  return {
    candidates: enrichedCandidates,
    summary: {
      attempted: uncached.length,
      enriched: statuses.filter((status) => status === "enriched").length,
      abstractMissing: statuses.filter((status) => status === "abstract-missing").length,
      notFound: statuses.filter((status) => status === "not-found").length,
      failed: statuses.filter((status) => status === "error").length,
      noDoi
    }
  };
}
