import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { collect, selectBalanced } from "./collect";
import { previousShanghaiDate, formatShanghaiDate } from "../src/lib/dates";
import { editionSchema, rawSnapshotSchema, type Edition, type RawSnapshot } from "../src/lib/schema";
import { loadAndValidateEdition } from "./validate";
import { applyEditorialControls } from "./lib/editorial";
import { deduplicateCandidates } from "./lib/candidates";

type Options = {
  dryRun: boolean;
  publish: boolean;
  force: boolean;
  reuseOutput: boolean;
  date?: string;
  candidateLimit?: number;
  reasoningEffort?: string;
};
export type LocalState = {
  schemaVersion: 1;
  runs: Array<{ date: string; completedAt: string; tokenTotal: number; published: boolean }>;
  nextEligibleAt?: string;
};

type UsageRun = {
  runId: string;
  date: string;
  completedAt: string;
  outcome: "published" | "validated" | "failed";
  failureReason?: string;
  metrics: Edition["metrics"];
};

const root = path.resolve(".");
const runtimeDirectory = path.join(root, ".runtime");
const statePath = path.join(root, "data/status/local-state.json");

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    publish: false,
    force: false,
    reuseOutput: false,
    candidateLimit: 60,
    reasoningEffort: "medium"
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") options.dryRun = true;
    else if (argv[index] === "--publish") options.publish = true;
    else if (argv[index] === "--force") options.force = true;
    else if (argv[index] === "--reuse-output") options.reuseOutput = true;
    else if (argv[index] === "--date") options.date = argv[++index];
    else if (argv[index] === "--candidate-limit") options.candidateLimit = Number(argv[++index]);
    else if (argv[index] === "--reasoning-effort") options.reasoningEffort = argv[++index];
  }
  if (options.candidateLimit !== undefined && (!Number.isInteger(options.candidateLimit) || options.candidateLimit < 1 || options.candidateLimit > 90)) {
    throw new Error("--candidate-limit must be an integer from 1 to 90.");
  }
  return options;
}

export function shouldWaitForCloudSnapshot(targetDate: string, expectedDate: string, now: Date): boolean {
  if (targetDate !== expectedDate) return false;
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minutesAfterMidnight = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  return minutesAfterMidnight < 3 * 60 + 30;
}

async function timedPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    console.log(`[timing] phase=${phase} outcome=ok duration_ms=${Date.now() - startedAt}`);
    return result;
  } catch (error) {
    console.error(`[timing] phase=${phase} outcome=failed duration_ms=${Date.now() - startedAt}`);
    throw error;
  }
}

function timedPhaseSync<T>(phase: string, operation: () => T): T {
  const startedAt = Date.now();
  try {
    const result = operation();
    console.log(`[timing] phase=${phase} outcome=ok duration_ms=${Date.now() - startedAt}`);
    return result;
  } catch (error) {
    console.error(`[timing] phase=${phase} outcome=failed duration_ms=${Date.now() - startedAt}`);
    throw error;
  }
}

function readState(): LocalState {
  if (!fs.existsSync(statePath)) return { schemaVersion: 1, runs: [] };
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as LocalState;
  } catch {
    return { schemaVersion: 1, runs: [] };
  }
}

function saveState(state: LocalState) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function listDates(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => b.localeCompare(a));
}

export function chooseTargetDate(rawDates: string[], editionDates: string[], expectedDate: string): string | undefined {
  const published = new Set(editionDates);
  // The latest complete day always wins, even when its cloud snapshot is late;
  // main() will invoke the same collector locally before calling Codex.
  if (!published.has(expectedDate)) return expectedDate;
  return rawDates.find((date) => date <= expectedDate && !published.has(date));
}

export function assertRunAllowed(state: LocalState, now: Date, force: boolean) {
  if (force) return;
  const today = formatShanghaiDate(now);
  const todayRuns = state.runs.filter((run) => formatShanghaiDate(new Date(run.completedAt)) === today);
  if (todayRuns.length >= 2) throw new Error("Daily catch-up limit reached: two editions have already completed today.");
  if (state.nextEligibleAt && now < new Date(state.nextEligibleAt)) {
    throw new Error(`Cooldown active until ${state.nextEligibleAt}.`);
  }
}

function runCommand(command: string, args: string[], options: { capture?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWindowsNpm = process.platform === "win32" && command === "npm";
    const executable = isWindowsNpm ? process.execPath : command;
    const executableArgs = isWindowsNpm
      ? [
          process.env.npm_execpath
            || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
          ...args,
        ]
      : args;
    const child = spawn(executable, executableArgs, { cwd: root, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(" ")} exited ${code}. ${stderr}`)));
  });
}

function runCodex(prompt: string, schemaPath: string, outputPath: string, eventPath: string, requestedEffort?: string): Promise<void> {
  const executable = process.env.CODEX_EXECUTABLE || "codex";
  const reasoningEffort = requestedEffort || process.env.CODEX_REASONING_EFFORT || "medium";
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(reasoningEffort)) {
    throw new Error(`Unsupported CODEX_REASONING_EFFORT: ${reasoningEffort}`);
  }
  const args = [
    // Daily news generation is self-contained. Loading third-party plugins can
    // trigger marketplace upgrades and add unrelated context/token overhead.
    "--disable", "plugins",
    "--disable", "memories",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--model", process.env.CODEX_MODEL || "gpt-5.6-sol",
    "--config", `model_reasoning_effort=${reasoningEffort}`,
    "--sandbox", "read-only",
    "--json",
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "-"
  ];
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(eventPath), { recursive: true });
    const events = fs.createWriteStream(eventPath, { encoding: "utf8" });
    const child = spawn(executable, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.stdin.end(prompt);
    child.stdout.pipe(events);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => {
      events.end();
      reject(new Error(`Unable to start Codex CLI (${executable}). Set CODEX_EXECUTABLE if needed. ${error.message}`));
    });
    child.on("close", (code) => {
      events.end();
      if (code === 0) resolve();
      else reject(new Error(`Codex CLI exited with code ${code}.`));
    });
  });
}

function findUsage(value: unknown): { input: number; output: number } {
  let best = { input: 0, output: 0 };
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const input = Number(record.input_tokens ?? record.inputTokens ?? 0);
    const output = Number(record.output_tokens ?? record.outputTokens ?? 0);
    if (input + output > best.input + best.output) best = { input, output };
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return best;
}

function parseUsage(eventPath: string): { input: number; output: number; total: number; measured: boolean } {
  if (!fs.existsSync(eventPath)) return { input: 0, output: 0, total: 0, measured: false };
  let best = { input: 0, output: 0 };
  for (const line of fs.readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const usage = findUsage(JSON.parse(line));
      if (usage.input + usage.output > best.input + best.output) best = usage;
    } catch {
      // Progress output can include non-JSON diagnostic lines on older CLI builds.
    }
  }
  return { ...best, total: best.input + best.output, measured: best.input + best.output > 0 };
}

function tokenUsageMetrics(usage: ReturnType<typeof parseUsage>) {
  const total = usage.total;
  return {
    measured: usage.measured,
    candidateJudgment: Math.round(total * 0.125),
    verification: Math.round(total * 0.5),
    bilingualGeneration: Math.round(total * 0.25),
    contentChecks: total - Math.round(total * 0.875),
    repairReserve: 0,
    input: usage.input,
    output: usage.output,
    total
  };
}

function failedAttemptMetrics(candidateCount: number, usage: ReturnType<typeof parseUsage>): Edition["metrics"] {
  return {
    candidateCount,
    pagesOpened: 0,
    searchGroups: 0,
    verifiedCount: 0,
    pendingCount: 0,
    rejectedCount: candidateCount,
    tokenUsage: tokenUsageMetrics(usage)
  };
}

function applyMeasuredUsage(edition: Edition, usage: ReturnType<typeof parseUsage>, candidateCount: number): Edition {
  const verifiedCount = edition.items.filter((item) => item.verificationStatus === "verified").length;
  const pendingCount = edition.items.length - verifiedCount;
  return editionSchema.parse({
    ...edition,
    metrics: {
      ...edition.metrics,
      candidateCount,
      pagesOpened: 0,
      searchGroups: 0,
      verifiedCount,
      pendingCount,
      rejectedCount: Math.max(0, candidateCount - edition.items.length),
      tokenUsage: tokenUsageMetrics(usage)
    }
  });
}

export function toCodexOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCodexOutputSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "format" && child === "uri") continue;
    output[key] = toCodexOutputSchema(child);
  }
  if (source.type === "object" && source.properties && typeof source.properties === "object") {
    const originalRequired = new Set(Array.isArray(source.required) ? source.required as string[] : []);
    const properties = output.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (!originalRequired.has(key)) {
        properties[key] = { anyOf: [properties[key], { type: "null" }] };
      }
    }
    output.required = Object.keys(properties);
  }
  return output;
}

export function stripNullObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullObjectFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => child !== null || key === "subjectOrganization")
      .map(([key, child]) => [key, stripNullObjectFields(child)])
  );
}

export function limitSnapshotCandidates(snapshot: RawSnapshot, candidateLimit = 60): RawSnapshot {
  const limit = Math.min(candidateLimit, snapshot.candidates.length);
  return rawSnapshotSchema.parse({
    ...snapshot,
    candidates: snapshot.candidates.slice(0, limit),
    notes: limit < snapshot.candidates.length
      ? [...snapshot.notes, `Token-controlled submission: ${limit} of ${snapshot.candidates.length} balanced candidates.`]
      : snapshot.notes
  });
}

function buildPrompt(date: string, rawPath: string, candidateLimit = 60): string {
  const template = fs.readFileSync(path.join(root, "automation/EDITOR_PROMPT.md"), "utf8");
  const registry = fs.readFileSync(path.join(root, "config/sources.json"), "utf8");
  const snapshot = rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(rawPath, "utf8")));
  const submittedSnapshot = limitSnapshotCandidates(snapshot, candidateLimit);
  return `${template.replaceAll("{{DATE}}", date)}\n\n<allowlist_registry>\n${registry}\n</allowlist_registry>\n\n<raw_snapshot>\n${JSON.stringify(submittedSnapshot, null, 2)}\n</raw_snapshot>\n`;
}

function recoverGeneratedOutput(eventPath: string, outputPath: string): boolean {
  if (!fs.existsSync(eventPath)) return false;
  const lines = fs.readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type !== "item.completed" || event.item?.type !== "agent_message" || !event.item.text) continue;
      JSON.parse(event.item.text);
      fs.writeFileSync(outputPath, `${event.item.text}\n`, "utf8");
      return true;
    } catch {
      // Continue to earlier event lines until a complete structured response is found.
    }
  }
  return false;
}

function readUsageRuns(report: Record<string, unknown> | undefined): UsageRun[] {
  if (!report) return [];
  if (report.schemaVersion === 2 && Array.isArray(report.runs)) return report.runs as UsageRun[];
  if (report.schemaVersion !== 1 || !Array.isArray(report.editions)) return [];
  const generatedAt = typeof report.generatedAt === "string" ? report.generatedAt : new Date(0).toISOString();
  return (report.editions as Array<Record<string, unknown>>).map((entry, index) => ({
    runId: `${String(entry.date)}-legacy-${index + 1}`,
    date: String(entry.date),
    completedAt: generatedAt,
    outcome: "published" as const,
    metrics: {
      candidateCount: Number(entry.candidateCount ?? 0),
      pagesOpened: Number(entry.pagesOpened ?? 0),
      searchGroups: Number(entry.searchGroups ?? 0),
      verifiedCount: Number(entry.verifiedCount ?? 0),
      pendingCount: Number(entry.pendingCount ?? 0),
      rejectedCount: Number(entry.rejectedCount ?? 0),
      tokenUsage: entry.tokenUsage as Edition["metrics"]["tokenUsage"]
    }
  }));
}

function writeMonthlyUsage(date: string, attempt?: UsageRun): string {
  const month = date.slice(0, 7);
  const editions = listDates(path.join(root, "data/editions"))
    .filter((editionDate) => editionDate.startsWith(month))
    .map((editionDate) => editionSchema.parse(JSON.parse(fs.readFileSync(path.join(root, `data/editions/${editionDate}.json`), "utf8"))));
  const sum = (selector: (edition: Edition) => number) => editions.reduce((total, edition) => total + selector(edition), 0);
  const outputPath = path.join(root, `data/usage/${month}.json`);
  let previous: Record<string, unknown> | undefined;
  if (fs.existsSync(outputPath)) {
    try { previous = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Record<string, unknown>; } catch { /* Rebuild below. */ }
  }
  const runs = readUsageRuns(previous);
  if (attempt) {
    const existingIndex = runs.findIndex((run) => run.runId === attempt.runId);
    if (existingIndex >= 0) runs[existingIndex] = attempt;
    else runs.push(attempt);
  }
  const actualTokens = runs.reduce((total, run) => total + run.metrics.tokenUsage.total, 0);
  const report = {
    schemaVersion: 2,
    month,
    generatedAt: new Date().toISOString(),
    totals: {
      editions: editions.length,
      candidates: sum((edition) => edition.metrics.candidateCount),
      pagesOpened: sum((edition) => edition.metrics.pagesOpened),
      searchGroups: sum((edition) => edition.metrics.searchGroups),
      verified: sum((edition) => edition.metrics.verifiedCount),
      pending: sum((edition) => edition.metrics.pendingCount),
      rejected: sum((edition) => edition.metrics.rejectedCount),
      tokens: actualTokens,
      currentEditionTokens: sum((edition) => edition.metrics.tokenUsage.total),
      measuredRuns: runs.filter((run) => run.metrics.tokenUsage.measured).length,
      runs: runs.length
    },
    editions: editions.map((edition) => ({ date: edition.date, status: edition.status, ...edition.metrics })),
    runs
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

function mergeSourceResults(left: RawSnapshot["sourceResults"], right: RawSnapshot["sourceResults"]): RawSnapshot["sourceResults"] {
  const statusPriority = { "no-feed": 0, empty: 1, failed: 2, ok: 3 } as const;
  const merged = new Map<string, RawSnapshot["sourceResults"][number]>();
  for (const result of [...left, ...right]) {
    const current = merged.get(result.sourceId);
    if (!current) {
      merged.set(result.sourceId, { ...result });
      continue;
    }
    const preferred = statusPriority[result.status] > statusPriority[current.status] ? result : current;
    const errors = [...new Set([current.error, result.error].filter((value): value is string => Boolean(value)))];
    merged.set(result.sourceId, {
      sourceId: result.sourceId,
      status: preferred.status,
      count: Math.max(current.count, result.count),
      ...(preferred.status === "failed" && errors.length ? { error: errors.join(" | ") } : {})
    });
  }
  return [...merged.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function mergeRawSnapshots(primary: RawSnapshot, recovered: RawSnapshot): RawSnapshot {
  if (primary.date !== recovered.date) {
    throw new Error(`Cannot merge raw snapshots for different dates: ${primary.date} and ${recovered.date}.`);
  }
  const primaryUrls = new Set(primary.candidates.map((candidate) => candidate.canonicalUrl));
  const recoveredOnly = recovered.candidates.filter((candidate) => !primaryUrls.has(candidate.canonicalUrl)).length;
  const candidates = selectBalanced(deduplicateCandidates([...primary.candidates, ...recovered.candidates]), 90);
  return rawSnapshotSchema.parse({
    ...primary,
    collectedAt: new Date(Math.max(new Date(primary.collectedAt).getTime(), new Date(recovered.collectedAt).getTime())).toISOString(),
    candidates,
    sourceResults: mergeSourceResults(primary.sourceResults, recovered.sourceResults),
    notes: [...new Set([
      ...primary.notes,
      ...recovered.notes,
      `Recovered local snapshot and merged ${recoveredOnly} URL-unique candidates before deduplication; retained ${candidates.length} balanced candidates.`
    ])]
  });
}

function writeRawSnapshot(outputPath: string, snapshot: RawSnapshot) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  if (fs.existsSync(outputPath)) {
    fs.copyFileSync(temporaryPath, outputPath);
    fs.rmSync(temporaryPath, { force: true });
  } else {
    fs.renameSync(temporaryPath, outputPath);
  }
}

export function mergeRawSnapshotFiles(primaryPath: string, recoveryPath: string): RawSnapshot {
  const primary = rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(primaryPath, "utf8")));
  const recovered = rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(recoveryPath, "utf8")));
  const merged = mergeRawSnapshots(primary, recovered);
  writeRawSnapshot(primaryPath, merged);
  return merged;
}

type ArchivedRawSnapshot = {
  repositoryPath: string;
  recoveryPath: string;
};

async function isTrackedAtHead(repositoryPath: string): Promise<boolean> {
  try {
    await runCommand("git", ["cat-file", "-e", `HEAD:${repositoryPath}`], { capture: true });
    return true;
  } catch {
    return false;
  }
}

async function archiveDirtyRawSnapshots(): Promise<ArchivedRawSnapshot[]> {
  const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "data/raw"], { capture: true });
  const dirtyEntries = status.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    repositoryPath: line.slice(3).trim().replaceAll("\\", "/")
  })).filter((entry) => /^data\/raw\/\d{4}-\d{2}-\d{2}\.json$/.test(entry.repositoryPath));
  if (!dirtyEntries.length) return [];

  const recoveryDirectory = path.join(runtimeDirectory, "recovery");
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  const archived: ArchivedRawSnapshot[] = [];
  for (const [index, entry] of dirtyEntries.entries()) {
    const sourcePath = path.join(root, ...entry.repositoryPath.split("/"));
    const recoveryPath = path.join(
      recoveryDirectory,
      `${path.basename(entry.repositoryPath, ".json")}-local-${Date.now()}-${index + 1}.json`
    );
    rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
    fs.copyFileSync(sourcePath, recoveryPath);
    archived.push({ repositoryPath: entry.repositoryPath, recoveryPath });

    if (await isTrackedAtHead(entry.repositoryPath)) {
      await runCommand("git", ["restore", "--staged", "--worktree", "--source=HEAD", "--", entry.repositoryPath]);
    } else {
      if (entry.status !== "??") await runCommand("git", ["reset", "--", entry.repositoryPath]);
      fs.rmSync(sourcePath, { force: true });
    }
    console.log(`Archived local raw snapshot before sync: ${entry.repositoryPath} -> ${path.relative(root, recoveryPath)}`);
  }
  return archived;
}

function restoreArchivedRawSnapshots(archived: ArchivedRawSnapshot[]) {
  for (const entry of archived) {
    const destinationPath = path.join(root, ...entry.repositoryPath.split("/"));
    const recovered = rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(entry.recoveryPath, "utf8")));
    const snapshot = fs.existsSync(destinationPath)
      ? mergeRawSnapshotFiles(destinationPath, entry.recoveryPath)
      : recovered;
    if (!fs.existsSync(destinationPath)) writeRawSnapshot(destinationPath, snapshot);
    console.log(`Restored and merged local raw snapshot: ${entry.repositoryPath} (${snapshot.candidates.length} candidates).`);
  }
}

async function synchronizeRepository() {
  await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });
  const archived = await archiveDirtyRawSnapshots();
  try {
    await runCommand("git", ["pull", "--rebase"]);
  } catch (error) {
    restoreArchivedRawSnapshots(archived);
    throw error;
  }
  restoreArchivedRawSnapshots(archived);
}

async function publishEdition(date: string, rawPath: string, editionPath: string, usagePath: string) {
  // A cloud snapshot is already tracked, while a locally recovered snapshot is
  // new. Stage it either way so fallback collection cannot leave the worktree
  // dirty and block a later pull --rebase.
  await runCommand("git", [
    "add",
    "--",
    path.relative(root, rawPath),
    path.relative(root, editionPath),
    path.relative(root, usagePath)
  ]);
  await runCommand("git", ["commit", "-m", `content: publish ${date} edition`]);
  try {
    await runCommand("git", ["push"]);
  } catch {
    await runCommand("git", ["pull", "--rebase"]);
    await runCommand("git", ["push"]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const expectedDate = previousShanghaiDate(now);
  const state = readState();
  if (options.publish && !options.dryRun) {
    await timedPhase("sync", synchronizeRepository);
  }

  let rawDates = listDates(path.join(root, "data/raw"));
  const editionDates = listDates(path.join(root, "data/editions"));
  let targetDate = options.date ?? chooseTargetDate(rawDates, editionDates, expectedDate);
  if (!targetDate) {
    targetDate = expectedDate;
    if (editionDates.includes(targetDate)) {
      console.log(`No missing edition. Latest complete day ${targetDate} is already published.`);
      return;
    }
  }
  assertRunAllowed(state, now, options.force);

  const rawPath = path.join(root, `data/raw/${targetDate}.json`);
  if (!fs.existsSync(rawPath)) {
    if (shouldWaitForCloudSnapshot(targetDate, expectedDate, now)) {
      console.log(`Cloud snapshot for ${targetDate} is not available yet; local fallback starts at 03:30 Asia/Shanghai.`);
      return;
    }
    if (options.dryRun) {
      console.log(`[dry-run] Would collect missing raw snapshot for ${targetDate}, then run Codex.`);
      return;
    }
    console.log(`Raw snapshot missing for ${targetDate}; running local deterministic collector.`);
    await timedPhase("collect", () => collect(targetDate));
    rawDates = listDates(path.join(root, "data/raw"));
  }
  const snapshot = rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(rawPath, "utf8")));
  const submittedCandidateCount = Math.min(options.candidateLimit ?? snapshot.candidates.length, snapshot.candidates.length);

  if (options.dryRun) {
    console.log(JSON.stringify({ targetDate, rawPath, publish: options.publish, runCountToday: state.runs.filter((run) => formatShanghaiDate(new Date(run.completedAt)) === formatShanghaiDate(now)).length }, null, 2));
    return;
  }

  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const schemaPath = path.join(runtimeDirectory, "edition-output.schema.json");
  const outputPath = path.join(runtimeDirectory, `edition-${targetDate}.json`);
  const generatedOutputPath = path.join(runtimeDirectory, `edition-${targetDate}.generated.json`);
  const eventPath = path.join(runtimeDirectory, `codex-${targetDate}.jsonl`);
  const runId = `${targetDate}-${now.toISOString()}`;
  const zeroUsage = { input: 0, output: 0, total: 0, measured: false };
  const jsonSchema = z.toJSONSchema(editionSchema, { target: "draft-7" });
  // Responses strict schemas require every property while the public data
  // schema has optional fields. Represent those as nullable for generation;
  // remove nulls before the unchanged runtime Zod validation.
  const codexSchema = JSON.stringify(toCodexOutputSchema(jsonSchema), null, 2);
  fs.writeFileSync(schemaPath, `${codexSchema}\n`, "utf8");
  let usage = { input: 0, output: 0, total: 0, measured: false };
  let attemptUsage = zeroUsage;
  let edition: Edition;
  try {
    if (options.reuseOutput) {
      if (!fs.existsSync(generatedOutputPath) && !recoverGeneratedOutput(eventPath, generatedOutputPath)) {
        throw new Error(`Cannot reuse output for ${targetDate}; generated JSON and recoverable usage events are missing.`);
      }
      console.log(`Reusing existing Codex output for ${targetDate}; no new model call will be made.`);
    } else {
      await timedPhase("codex", () => runCodex(
        buildPrompt(targetDate, rawPath, options.candidateLimit),
        schemaPath,
        generatedOutputPath,
        eventPath,
        options.reasoningEffort
      ));
    }

    edition = timedPhaseSync("validate", () => {
      const rawEdition = editionSchema.parse(stripNullObjectFields(JSON.parse(fs.readFileSync(generatedOutputPath, "utf8"))));
      if (rawEdition.date !== targetDate) throw new Error(`Codex returned ${rawEdition.date}; expected ${targetDate}.`);
      usage = parseUsage(eventPath);
      attemptUsage = options.reuseOutput ? zeroUsage : usage;
      if (usage.measured && usage.total > 80_000) throw new Error(`Run used ${usage.total} tokens, exceeding the 80,000 ceiling; edition rejected.`);
      const controlledEdition = applyEditorialControls(rawEdition);
      const measuredEdition = applyMeasuredUsage(controlledEdition, usage, submittedCandidateCount);
      fs.writeFileSync(outputPath, `${JSON.stringify(measuredEdition, null, 2)}\n`, "utf8");
      loadAndValidateEdition(outputPath);
      return measuredEdition;
    });
  } catch (error) {
    attemptUsage = options.reuseOutput ? zeroUsage : parseUsage(eventPath);
    writeMonthlyUsage(targetDate, {
      runId, date: targetDate, completedAt: new Date().toISOString(), outcome: "failed",
      failureReason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      metrics: failedAttemptMetrics(submittedCandidateCount, attemptUsage)
    });
    throw error;
  }

  const editionPath = path.join(root, `data/editions/${targetDate}.json`);
  if (fs.existsSync(editionPath) && !options.force) throw new Error(`Edition already exists: ${editionPath}`);
  const previousEdition = fs.existsSync(editionPath) ? fs.readFileSync(editionPath, "utf8") : undefined;
  fs.mkdirSync(path.dirname(editionPath), { recursive: true });
  fs.copyFileSync(outputPath, editionPath);
  const usagePath = path.join(root, `data/usage/${targetDate.slice(0, 7)}.json`);
  const successfulAttempt: UsageRun = {
    runId, date: targetDate, completedAt: new Date().toISOString(), outcome: options.publish ? "published" : "validated",
    metrics: { ...edition.metrics, tokenUsage: tokenUsageMetrics(attemptUsage) }
  };
  writeMonthlyUsage(targetDate, successfulAttempt);
  try {
    await timedPhase("build", () => runCommand("npm", ["run", "build"]));
  } catch (error) {
    if (previousEdition === undefined) fs.rmSync(editionPath, { force: true });
    else fs.writeFileSync(editionPath, previousEdition, "utf8");
    writeMonthlyUsage(targetDate, {
      ...successfulAttempt,
      completedAt: new Date().toISOString(),
      outcome: "failed",
      failureReason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)
    });
    throw error;
  }
  if (options.publish) {
    await timedPhase("push", () => publishEdition(targetDate, rawPath, editionPath, usagePath));
  }

  const completedAt = new Date().toISOString();
  state.runs.push({ date: targetDate, completedAt, tokenTotal: usage.total, published: options.publish });
  state.runs = state.runs.slice(-120);
  state.nextEligibleAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  saveState(state);
  console.log(`Edition ${targetDate} validated${options.publish ? " and published" : ""}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
