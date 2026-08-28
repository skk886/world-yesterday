import { z } from "zod";

export const categories = [
  "world",
  "technology",
  "ai",
  "science",
  "society",
  "business",
  "health",
  "climate",
  "entertainment",
  "games",
  "culture-sports"
] as const;

export const categoryLabels: Record<(typeof categories)[number], { zh: string; en: string }> = {
  world: { zh: "国际", en: "World" },
  technology: { zh: "科技", en: "Technology" },
  ai: { zh: "AI", en: "AI" },
  science: { zh: "科学", en: "Science" },
  society: { zh: "社会", en: "Society" },
  business: { zh: "财经", en: "Business" },
  health: { zh: "健康", en: "Health" },
  climate: { zh: "气候", en: "Climate" },
  entertainment: { zh: "娱乐", en: "Entertainment" },
  games: { zh: "游戏", en: "Games" },
  "culture-sports": { zh: "文化体育", en: "Culture & Sports" }
};

export const categoryTargets: Record<(typeof categories)[number], number> = {
  world: 5,
  technology: 3,
  ai: 3,
  science: 4,
  society: 3,
  business: 2,
  health: 2,
  climate: 2,
  entertainment: 3,
  games: 2,
  "culture-sports": 1
};

export const topics = [
  "aerospace",
  "artificial-intelligence",
  "digital-infrastructure",
  "life-sciences",
  "earth-science",
  "energy-materials",
  "health-medicine",
  "climate-environment",
  "economy-finance",
  "conflict-security",
  "public-policy",
  "film-television",
  "music-entertainment",
  "games-industry",
  "game-development",
  "games-release",
  "esports",
  "culture-sports",
  "general"
] as const;

export const importanceWeights = {
  impactBreadth: 0.30,
  consequenceSeverity: 0.25,
  systemicSignificance: 0.20,
  independentCoverage: 0.15,
  yesterdayNovelty: 0.10
} as const;

const localizedTextSchema = z.object({
  zh: z.string().min(1),
  en: z.string().min(1)
});

export const journalIds = ["science", "nature"] as const;

export const journalHighlightSchema = z.object({
  journal: z.enum(journalIds),
  journalName: z.enum(["Science", "Nature"]),
  status: z.enum(["selected", "no-update", "metadata-insufficient"]),
  candidateId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  originalTitle: z.string().min(1).optional(),
  titles: localizedTextSchema.optional(),
  summaries: localizedTextSchema.optional(),
  whyItMatters: localizedTextSchema.optional(),
  topic: z.enum(topics).optional(),
  doi: z.string().min(6).max(200).optional(),
  url: z.string().url().optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  metadataSource: z.enum(["rss", "crossref"]).optional(),
  notice: localizedTextSchema
});

export const sourceCitationSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  domain: z.string().min(1),
  type: z.enum(["primary", "independent-media", "state-media"]),
  language: z.string().min(2).max(16),
  publishedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional()
});

export const newsItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{5,80}$/),
  category: z.enum(categories),
  rank: z.number().int().min(1).max(30),
  titles: localizedTextSchema,
  originalTitle: z.string().min(1),
  summaries: localizedTextSchema,
  whyItMatters: localizedTextSchema,
  sources: z.array(sourceCitationSchema).min(1).max(6),
  verificationStatus: z.enum(["verified", "pending"]),
  pendingReason: localizedTextSchema.optional(),
  eventAt: z.string().datetime({ offset: true }).optional(),
  publishedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  regions: z.array(z.string().min(2)).min(1).max(8),
  topic: z.enum(topics),
  subjectOrganization: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
    name: z.string().min(1).max(160)
  }).nullable(),
  importanceFactors: z.object({
    impactBreadth: z.number().min(0).max(100),
    consequenceSeverity: z.number().min(0).max(100),
    systemicSignificance: z.number().min(0).max(100),
    independentCoverage: z.number().min(0).max(100),
    yesterdayNovelty: z.number().min(0).max(100)
  }),
  impactScore: z.number().min(0).max(100)
});

export const tokenUsageSchema = z.object({
  measured: z.boolean(),
  candidateJudgment: z.number().int().min(0),
  verification: z.number().int().min(0),
  bilingualGeneration: z.number().int().min(0),
  contentChecks: z.number().int().min(0),
  repairReserve: z.number().int().min(0),
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  total: z.number().int().min(0).max(80_000)
});

export const editionMetricsSchema = z.object({
  candidateCount: z.number().int().min(0).max(90),
  pagesOpened: z.number().int().min(0).max(60),
  searchGroups: z.number().int().min(0).max(16),
  verifiedCount: z.number().int().min(0),
  pendingCount: z.number().int().min(0).max(15),
  rejectedCount: z.number().int().min(0),
  tokenUsage: tokenUsageSchema
});

const editionBaseSchema = {
  siteName: z.literal("昨日世界 / World Yesterday"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().datetime({ offset: true }),
  timezone: z.literal("Asia/Shanghai"),
  status: z.enum(["complete", "partial"]),
  items: z.array(newsItemSchema).max(30),
  metrics: editionMetricsSchema
} as const;

export const editionV3Schema = z.object({
  schemaVersion: z.literal(3),
  ...editionBaseSchema
});

export const editionV4Schema = z.object({
  schemaVersion: z.literal(4),
  ...editionBaseSchema,
  journalHighlights: z.array(journalHighlightSchema).length(2)
});

// Schema 3 remains readable so permanent archives continue to build. New
// generations use editionV4Schema and always publish the two journal slots.
export const editionSchema = z.union([editionV4Schema, editionV3Schema]);

export type Category = (typeof categories)[number];
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type Edition = z.infer<typeof editionSchema>;
export type EditionV4 = z.infer<typeof editionV4Schema>;
export type JournalHighlight = z.infer<typeof journalHighlightSchema>;

export const metadataEnrichmentSchema = z.object({
  provider: z.literal("crossref"),
  status: z.enum(["enriched", "abstract-missing", "not-found", "error"]),
  doi: z.string().min(6).max(200),
  fetchedAt: z.string().datetime({ offset: true }),
  abstract: z.string().min(1).max(4_000).optional(),
  sourceUrl: z.string().url().optional(),
  error: z.string().max(500).optional()
});

export const rawCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  sourceId: z.string(),
  sourceName: z.string(),
  domain: z.string(),
  sourceType: z.enum(["primary", "independent-media", "state-media"]),
  sourceTier: z.enum(["A", "B"]),
  language: z.string(),
  publishedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  description: z.string().optional(),
  rssDescription: z.string().optional(),
  doi: z.string().min(6).max(200).optional(),
  journalContentType: z.string().max(120).optional(),
  metadataEnrichment: metadataEnrichmentSchema.optional(),
  discovery: z.enum(["rss", "gdelt"]),
  categoryHints: z.array(z.enum(categories)).min(1).max(1),
  topic: z.enum(topics),
  preliminaryScore: z.number().min(0).max(100)
});

export const rawSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.literal("Asia/Shanghai"),
  collectedAt: z.string().datetime({ offset: true }),
  window: z.object({ start: z.string().datetime(), end: z.string().datetime() }),
  candidates: z.array(rawCandidateSchema).max(90),
  sourceResults: z.array(z.object({
    sourceId: z.string(),
    status: z.enum(["ok", "failed", "no-feed", "empty"]),
    count: z.number().int().min(0),
    error: z.string().optional()
  })),
  notes: z.array(z.string())
});

export type RawCandidate = z.infer<typeof rawCandidateSchema>;
export type RawSnapshot = z.infer<typeof rawSnapshotSchema>;
