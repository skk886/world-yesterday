import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { collect } from "./collect";
import { previousShanghaiDate, formatShanghaiDate } from "../src/lib/dates";
import { editionSchema, rawSnapshotSchema, type Edition } from "../src/lib/schema";
import { loadAndValidateEdition } from "./validate";

type Options = { dryRun: boolean; publish: boolean; force: boolean; date?: string };
export type LocalState = {
  schemaVersion: 1;
  runs: Array<{ date: string; completedAt: string; tokenTotal: number; published: boolean }>;
  nextEligibleAt?: string;
};

const root = path.resolve(".");
const runtimeDirectory = path.join(root, ".runtime");
const statePath = path.join(root, "data/status/local-state.json");

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, publish: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") options.dryRun = true;
    else if (argv[index] === "--publish") options.publish = true;
    else if (argv[index] === "--force") options.force = true;
    else if (argv[index] === "--date") options.date = argv[++index];
  }
  return options;
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

function runCodex(prompt: string, schemaPath: string, outputPath: string, eventPath: string): Promise<void> {
  const executable = process.env.CODEX_EXECUTABLE || "codex";
  const reasoningEffort = process.env.CODEX_REASONING_EFFORT || "high";
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

function applyMeasuredUsage(edition: Edition, usage: ReturnType<typeof parseUsage>): Edition {
  const total = usage.total;
  return editionSchema.parse({
    ...edition,
    metrics: {
      ...edition.metrics,
      tokenUsage: {
        measured: usage.measured,
        candidateJudgment: Math.round(total * 0.125),
        verification: Math.round(total * 0.5),
        bilingualGeneration: Math.round(total * 0.25),
        contentChecks: total - Math.round(total * 0.875),
        repairReserve: 0,
        input: usage.input,
        output: usage.output,
        total
      }
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
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, stripNullObjectFields(child)])
  );
}

function buildPrompt(date: string, rawPath: string): string {
  const template = fs.readFileSync(path.join(root, "automation/EDITOR_PROMPT.md"), "utf8");
  const registry = fs.readFileSync(path.join(root, "config/sources.json"), "utf8");
  const snapshot = fs.readFileSync(rawPath, "utf8");
  return `${template.replaceAll("{{DATE}}", date)}\n\n<allowlist_registry>\n${registry}\n</allowlist_registry>\n\n<raw_snapshot>\n${snapshot}\n</raw_snapshot>\n`;
}

function writeMonthlyUsage(date: string): string {
  const month = date.slice(0, 7);
  const editions = listDates(path.join(root, "data/editions"))
    .filter((editionDate) => editionDate.startsWith(month))
    .map((editionDate) => editionSchema.parse(JSON.parse(fs.readFileSync(path.join(root, `data/editions/${editionDate}.json`), "utf8"))));
  const sum = (selector: (edition: Edition) => number) => editions.reduce((total, edition) => total + selector(edition), 0);
  const outputPath = path.join(root, `data/usage/${month}.json`);
  const report = {
    schemaVersion: 1,
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
      tokens: sum((edition) => edition.metrics.tokenUsage.total),
      measuredEditions: editions.filter((edition) => edition.metrics.tokenUsage.measured).length
    },
    editions: editions.map((edition) => ({ date: edition.date, status: edition.status, ...edition.metrics }))
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

async function synchronizeRepository() {
  await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });
  await runCommand("git", ["pull", "--rebase"]);
  await runCommand("git", ["push"]);
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
  assertRunAllowed(state, now, options.force);
  if (options.publish && !options.dryRun) await synchronizeRepository();

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

  const rawPath = path.join(root, `data/raw/${targetDate}.json`);
  if (!fs.existsSync(rawPath)) {
    if (options.dryRun) {
      console.log(`[dry-run] Would collect missing raw snapshot for ${targetDate}, then run Codex.`);
      return;
    }
    console.log(`Raw snapshot missing for ${targetDate}; running local deterministic collector.`);
    await collect(targetDate);
    rawDates = listDates(path.join(root, "data/raw"));
  }
  rawSnapshotSchema.parse(JSON.parse(fs.readFileSync(rawPath, "utf8")));

  if (options.dryRun) {
    console.log(JSON.stringify({ targetDate, rawPath, publish: options.publish, runCountToday: state.runs.filter((run) => formatShanghaiDate(new Date(run.completedAt)) === formatShanghaiDate(now)).length }, null, 2));
    return;
  }

  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const schemaPath = path.join(runtimeDirectory, "edition-output.schema.json");
  const outputPath = path.join(runtimeDirectory, `edition-${targetDate}.json`);
  const eventPath = path.join(runtimeDirectory, `codex-${targetDate}.jsonl`);
  const jsonSchema = z.toJSONSchema(editionSchema, { target: "draft-7" });
  // Responses strict schemas require every property while the public data
  // schema has optional fields. Represent those as nullable for generation;
  // remove nulls before the unchanged runtime Zod validation.
  const codexSchema = JSON.stringify(toCodexOutputSchema(jsonSchema), null, 2);
  fs.writeFileSync(schemaPath, `${codexSchema}\n`, "utf8");
  await runCodex(buildPrompt(targetDate, rawPath), schemaPath, outputPath, eventPath);

  const rawEdition = editionSchema.parse(stripNullObjectFields(JSON.parse(fs.readFileSync(outputPath, "utf8"))));
  if (rawEdition.date !== targetDate) throw new Error(`Codex returned ${rawEdition.date}; expected ${targetDate}.`);
  const usage = parseUsage(eventPath);
  if (usage.measured && usage.total > 80_000) throw new Error(`Run used ${usage.total} tokens, exceeding the 80,000 ceiling; edition rejected.`);
  const edition = applyMeasuredUsage(rawEdition, usage);
  fs.writeFileSync(outputPath, `${JSON.stringify(edition, null, 2)}\n`, "utf8");
  loadAndValidateEdition(outputPath);

  const editionPath = path.join(root, `data/editions/${targetDate}.json`);
  if (fs.existsSync(editionPath) && !options.force) throw new Error(`Edition already exists: ${editionPath}`);
  fs.mkdirSync(path.dirname(editionPath), { recursive: true });
  fs.copyFileSync(outputPath, editionPath);
  const usagePath = path.join(root, `data/usage/${targetDate.slice(0, 7)}.json`);
  const previousUsage = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, "utf8") : undefined;
  writeMonthlyUsage(targetDate);
  try {
    await runCommand("npm", ["run", "build"]);
  } catch (error) {
    fs.rmSync(editionPath, { force: true });
    if (previousUsage === undefined) fs.rmSync(usagePath, { force: true });
    else fs.writeFileSync(usagePath, previousUsage, "utf8");
    throw error;
  }
  if (options.publish) await publishEdition(targetDate, rawPath, editionPath, usagePath);

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
