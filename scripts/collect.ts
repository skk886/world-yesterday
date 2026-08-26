import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeUrl, deduplicateCandidates, stableCandidateId } from "./lib/candidates";
import { fetchText, parseFeed } from "./lib/feed";
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

function scoreCandidate(source: SourceDefinition, publishedAt: string, discovery: "rss" | "gdelt", hasDescription: boolean, date: string): number {
  const { start, end } = shanghaiDayWindow(date);
  const progress = Math.max(0, Math.min(1, (new Date(publishedAt).getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  return Math.min(100, Math.round(
    (source.tier === "A" ? 30 : 22) +
    (source.type === "independent-media" ? 15 : source.type === "primary" ? 18 : 7) +
    (discovery === "rss" ? 12 : 8) +
    (hasDescription ? 5 : 0) +
    progress * 15
  ));
}

function toCandidate(entry: { title: string; url: string; publishedAt?: string; updatedAt?: string; description?: string }, source: SourceDefinition, discovery: "rss" | "gdelt", date: string): RawCandidate | undefined {
  const publishedAt = isoDate(entry.publishedAt ?? entry.updatedAt);
  const updatedAt = isoDate(entry.updatedAt);
  if (!publishedAt || (!dateIsInShanghaiDay(publishedAt, date) && (!updatedAt || !dateIsInShanghaiDay(updatedAt, date)))) return undefined;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(entry.url);
  } catch {
    return undefined;
  }
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
    discovery,
    categoryHints: source.categories.slice(0, 4),
    preliminaryScore: scoreCandidate(source, updatedAt ?? publishedAt, discovery, Boolean(entry.description), date)
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
  const query = "(conflict OR election OR economy OR technology OR science OR health OR climate OR society OR culture OR sports)";
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

function selectBalanced(candidates: RawCandidate[], limit = 90): RawCandidate[] {
  const selected: RawCandidate[] = [];
  const remaining = [...candidates];
  const categories = ["world", "technology", "science", "society", "business", "health", "climate", "culture-sports"];
  for (const category of categories) {
    const matching = remaining.filter((candidate) => candidate.categoryHints.includes(category as never)).slice(0, 5);
    selected.push(...matching);
    for (const candidate of matching) remaining.splice(remaining.indexOf(candidate), 1);
  }
  selected.push(...remaining.slice(0, Math.max(0, limit - selected.length)));
  return selected.slice(0, limit);
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
  const candidates = selectBalanced(deduplicateCandidates([...feedResult.candidates, ...gdeltCandidates]));
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
    notes
  });
  const outputPath = path.resolve(output ?? `data/raw/${date}.json`);
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
