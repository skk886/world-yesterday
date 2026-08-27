import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { categories } from "../../src/lib/schema";

export const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().toLowerCase(),
  aliases: z.array(z.string().toLowerCase()).default([]),
  homepage: z.string().url().refine((value) => value.startsWith("https://"), "homepage must use HTTPS"),
  publisherGroup: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  tier: z.enum(["A", "B"]),
  type: z.enum(["primary", "independent-media", "state-media"]),
  language: z.string(),
  categories: z.array(z.enum(categories)),
  feeds: z.array(z.string().url())
});

const registrySchema = z.object({
  schemaVersion: z.literal(2),
  sources: z.array(sourceSchema)
}).superRefine((registry, context) => {
  const ids = new Set<string>();
  const domains = new Set<string>();
  for (const source of registry.sources) {
    if (ids.has(source.id)) context.addIssue({ code: "custom", message: `Duplicate source id: ${source.id}` });
    if (domains.has(source.domain)) context.addIssue({ code: "custom", message: `Duplicate source domain: ${source.domain}` });
    ids.add(source.id);
    domains.add(source.domain);
  }
});

export type SourceDefinition = z.infer<typeof sourceSchema>;

export function loadSourceRegistry(): SourceDefinition[] {
  const sourcePath = path.resolve("config/sources.json");
  return registrySchema.parse(JSON.parse(fs.readFileSync(sourcePath, "utf8"))).sources;
}

export function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function findAllowedSource(urlOrDomain: string, sources = loadSourceRegistry()): SourceDefinition | undefined {
  let hostname = urlOrDomain;
  try {
    hostname = new URL(urlOrDomain).hostname;
  } catch {
    // A bare domain is valid input.
  }
  const normalized = normalizeDomain(hostname);
  return sources.find((source) => [source.domain, ...source.aliases].some((domain) => {
    const allowed = normalizeDomain(domain);
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  }));
}

export function isAllowedUrl(url: string, sources = loadSourceRegistry()): boolean {
  return Boolean(findAllowedSource(url, sources));
}

export function sourceIndependenceKey(urlOrDomain: string, sources = loadSourceRegistry()): string | undefined {
  const source = findAllowedSource(urlOrDomain, sources);
  if (!source || source.type !== "independent-media") return undefined;
  return source.publisherGroup;
}
