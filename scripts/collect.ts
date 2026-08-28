import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeUrl, classifyArticle, deduplicateCandidates, isExcludedCandidate, stableCandidateId } from "./lib/candidates";
import { fetchText, parseFeed } from "./lib/feed";
import { enrichScienceCandidates, extractDoi } from "./lib/crossref";
import { selectJournalReserves } from "./lib/journals";
import { findAllowedSource, loadSourceRegistry, normalizeDomain, type SourceDefinition } from "./lib/sources";
import { dateIsInShanghaiDay, previousShanghaiDate, shanghaiDayWindow } from "../src/lib/dates";
import { rawSnapshotSchema, type RawCandidate } from "../src/lib/schema";

type CliOptions = { date: string; output?: string; noGdelt: boolean };

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { date: previousShanghaiDate(), noGdelt: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--date") options.date = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--no-gdelt") options.noGdelt = true;
  }
  return options;
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function scoreCandidate(publishedAt: string, discovery: "rss" | "gdelt", hasDescription: boolean, date: string): number {
  const { start, end } = shanghaiDayWindow(date);
  const progress = Math.max(0, Math.min(1, (new Date(publishedAt).getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  return Math.min(100, Math.round(
    45 +
    (discovery === "rss" ? 10 : 6) +
    (hasDescription ? 10 : 0) +
    progress * 20
  ));
}

function toCandidate(entry: { title: string; url: string; publishedAt?: string; updatedAt?: string; description?: string; doi?: string; contentType?: string }, source: SourceDefinition, discovery: "rss" | "gdelt", date: string): RawCandidate | undefined {
  const publishedAt = isoDate(entry.publishedAt ?? entry.updatedAt);
  const updatedAt = isoDate(entry.updatedAt);
  if (!publishedAt || (!dateIsInShanghaiDay(publishedAt, date) && (!updatedAt || !dateIsInShanghaiDay(updatedAt, date)))) return undefined;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(entry.url);
  } catch {
    return undefined;
  }
  const classification = classifyArticle(entry.title, entry.description);
  if (isExcludedCandidate(entry, classification)) return undefined;
  return {
    id: stableCandidateId(canonicalUrl),
    title: entry.title.trim(),
    url: entry.url,
    canonicalUrl,
    sourceId: source.id,
    sourceName: source.name,
    domain: normalizeDomain(new URL(canonicalUrl).hostname),
    sourceType: source.type,
    sourceTier: source.tier,
    language: source.language,
    publishedAt,
    updatedAt,
    description: entry.description,
    rssDescription: discovery === "rss" ? entry.description : undefined,
    doi: extractDoi(entry.doi, entry.url, canonicalUrl),
    journalContentType: entry.contentType,
    discovery,
    categoryHints: [classification.category],
    topic: classification.topic,
    preliminaryScore: scoreCandidate(updatedAt ?? publishedAt, discovery, Boolean(entry.description), date)
  };
}

async function collectFeeds(date: string, sources: SourceDefinition[]) {
  const candidates: RawCandidate[] = [];
  const results: Array<{ sourceId: string; status: "ok" | "failed" | "no-feed" | "empty"; count: number; error?: string }> = [];
  const work = sources.map(async (source) => {
    if (!source.feeds.length) {
      results.push({ sourceId: source.id, status: "no-feed", count: 0 });
      return;
    }
    let sourceCount = 0;
    const errors: string[] = [];
    for (const feed of source.feeds) {
      try {
        const xml = await fetchText(feed);
        const entries = parseFeed(xml);
        for (const entry of entries) {
          const candidate = toCandidate(entry, source, "rss", date);
          if (candidate) {
            candidates.push(candidate);
            sourceCount += 1;
          }
        }
      } catch (error) {
        errors.push(`${feed}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    results.push({
      sourceId: source.id,
      status: sourceCount ? "ok" : errors.length === source.feeds.length ? "failed" : "empty",
      count: sourceCount,
      ...(errors.length ? { error: errors.join(" | ").slice(0, 1000) } : {})
    });
  });
  await Promise.all(work);
  return { candidates, results };
}

function gdeltTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

async function collectGdelt(date: string, sources: SourceDefinition[]): Promise<RawCandidate[]> {
  const { start, end } = shanghaiDayWindow(date);
  const query = "(conflict OR election OR economy OR technology OR artificial intelligence OR science OR health OR climate OR society OR film OR television OR music OR gaming OR esports OR culture OR sports)";
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.search = new URLSearchParams({
    query,
    mode: "ArtList",
    maxrecords: "250",
    format: "json",
    sort: "HybridRel",
    startdatetime: gdeltTimestamp(start),
    enddatetime: gdeltTimestamp(end)
  }).toString();
  // Broad GDELT queries often queue for 30-60 seconds even when healthy.
  let raw: string;
  try {
    raw = await fetchText(url.toString(), 120_000);
  } catch (httpsError) {
    // Some Windows/ISP routes cannot complete GDELT's TLS handshake inside
    // Node's 10-second connect window. The same official endpoint also serves
    // HTTP; this fallback carries only a public discovery query, never secrets.
    url.protocol = "http:";
    try {
      raw = await fetchText(url.toString(), 120_000);
    } catch (httpError) {
      throw new Error(`HTTPS failed (${httpsError instanceof Error ? httpsError.message : String(httpsError)}); HTTP fallback failed (${httpError instanceof Error ? httpError.message : String(httpError)}).`);
    }
  }
  const payload = JSON.parse(raw) as { articles?: Array<Record<string, unknown>> };
  const candidates: RawCandidate[] = [];
  for (const article of payload.articles ?? []) {
    const articleUrl = String(article.url ?? "");
    const source = findAllowedSource(articleUrl, sources);
    if (!source) continue;
    const seen = String(article.seendate ?? article.date ?? "");
    const publishedAt = /^\d{8}T\d{6}Z$/.test(seen)
      ? `${seen.slice(0, 4)}-${seen.slice(4, 6)}-${seen.slice(6, 8)}T${seen.slice(9, 11)}:${seen.slice(11, 13)}:${seen.slice(13, 15)}Z`
      : seen;
    const candidate = toCandidate({
      title: String(article.title ?? ""),
      url: articleUrl,
      publishedAt,
      description: String(article.socialimage ? "Discovered through GDELT global coverage." : "")
    }, source, "gdelt", date);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function sourceCandidateLimit(candidate: RawCandidate): number {
  if (candidate.sourceType === "state-media") return 4;
  if (candidate.sourceType === "primary") return 6;
  return 12;
}

export function selectBalanced(candidates: RawCandidate[], limit = 90): RawCandidate[] {
  const selected: RawCandidate[] = selectJournalReserves(candidates).slice(0, limit);
  const selectedUrls = new Set(selected.map((candidate) => candidate.canonicalUrl));
  const sourceCounts = new Map<string, number>();
  for (const candidate of selected) sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
  const categoryOrder = ["world", "technology", "ai", "science", "society", "business", "health", "climate", "entertainment", "games", "culture-sports"] as const;
  const queues = new Map(categoryOrder.map((category) => [category, candidates.filter((candidate) => candidate.categoryHints[0] === category && !selectedUrls.has(candidate.canonicalUrl))]));

  while (selected.length < limit) {
    let addedThisRound = 0;
    for (const category of categoryOrder) {
      const queue = queues.get(category)!;
      let candidate: RawCandidate | undefined;
      while (queue.length) {
        const next = queue.shift()!;
        if ((sourceCounts.get(next.sourceId) ?? 0) < sourceCandidateLimit(next)) {
          candidate = next;
          break;
        }
      }
      if (!candidate) continue;
      selected.push(candidate);
      sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
      addedThisRound += 1;
      if (selected.length === limit) break;
    }
    if (!addedThisRound) break;
  }
  return selected;
}

function readExistingCandidates(outputPath: string, date: string): RawCandidate[] {
  if (!fs.existsSync(outputPath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { candidates?: Array<Partial<RawCandidate> & Pick<RawCandidate, "title">> };
    return (payload.candidates ?? []).map((candidate) => {
      const classification = classifyArticle(candidate.title, candidate.description);
      return {
        ...candidate,
        categoryHints: [classification.category],
        topic: classification.topic
      } as RawCandidate;
    }).filter((candidate) => {
      const isInWindow = dateIsInShanghaiDay(candidate.publishedAt, date)
        || Boolean(candidate.updatedAt && dateIsInShanghaiDay(candidate.updatedAt, date));
      return isInWindow
        && !isExcludedCandidate({ title: candidate.title, description: candidate.description, url: candidate.canonicalUrl });
    });
  } catch {
    return [];
  }
}

export async function collect(date: string, output?: string, noGdelt = false) {
  const sources = loadSourceRegistry();
  const feedResult = await collectFeeds(date, sources);
  const notes: string[] = [];
  let gdeltCandidates: RawCandidate[] = [];
  if (!noGdelt) {
    try {
      gdeltCandidates = await collectGdelt(date, sources);
    } catch (error) {
      notes.push(`GDELT unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const outputPath = path.resolve(output ?? `data/raw/${date}.json`);
  const existingCandidates = readExistingCandidates(outputPath, date);
  const combined = deduplicateCandidates([...feedResult.candidates, ...gdeltCandidates, ...existingCandidates]);
  const enrichment = await enrichScienceCandidates(combined, {
    limit: 40,
    concurrency: 3,
    timeoutMs: 10_000,
    attempts: 2,
    cachePath: path.resolve(".runtime/crossref-cache.json")
  });
  notes.push(
    `Crossref Science enrichment: attempted ${enrichment.summary.attempted}, enriched ${enrichment.summary.enriched}, abstract-missing ${enrichment.summary.abstractMissing}, not-found ${enrichment.summary.notFound}, failed ${enrichment.summary.failed}, no-DOI ${enrichment.summary.noDoi}.`
  );
  const candidates = selectBalanced(enrichment.candidates);
  if (!candidates.length) throw new Error("Collector returned no allowlisted candidates; existing snapshots were left untouched.");
  const { start, end } = shanghaiDayWindow(date);
  const snapshot = rawSnapshotSchema.parse({
    schemaVersion: 1,
    date,
    timezone: "Asia/Shanghai",
    collectedAt: new Date().toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
    candidates,
    sourceResults: feedResult.results.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    notes: existingCandidates.length ? [...notes, `Merged and deduplicated ${existingCandidates.length} candidates from the previous snapshot.`] : notes
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (!fs.existsSync(outputPath) || !["EEXIST", "EPERM"].includes(code)) throw error;
    fs.copyFileSync(temporaryPath, outputPath);
    fs.rmSync(temporaryPath, { force: true });
  }
  return { outputPath, snapshot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  collect(options.date, options.output, options.noGdelt)
    .then(({ outputPath, snapshot }) => {
      console.log(`Collected ${snapshot.candidates.length} candidates for ${snapshot.date} -> ${outputPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
