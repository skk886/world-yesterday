import { z } from "zod";

export const categories = [
  "world",
  "technology",
  "science",
  "society",
  "business",
  "health",
  "climate",
  "culture-sports"
] as const;

export const categoryLabels: Record<(typeof categories)[number], { zh: string; en: string }> = {
  world: { zh: "国际", en: "World" },
  technology: { zh: "科技", en: "Technology" },
  science: { zh: "科学", en: "Science" },
  society: { zh: "社会", en: "Society" },
  business: { zh: "财经", en: "Business" },
  health: { zh: "健康", en: "Health" },
  climate: { zh: "气候", en: "Climate" },
  "culture-sports": { zh: "文化体育", en: "Culture & Sports" }
};

export const categoryTargets: Record<(typeof categories)[number], number> = {
  world: 7,
  technology: 6,
  science: 5,
  society: 4,
  business: 3,
  health: 2,
  climate: 2,
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
  pendingCount: z.number().int().min(0).max(5),
  rejectedCount: z.number().int().min(0),
  tokenUsage: tokenUsageSchema
});

export const editionSchema = z.object({
  schemaVersion: z.literal(2),
  siteName: z.literal("昨日世界 / World Yesterday"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().datetime({ offset: true }),
  timezone: z.literal("Asia/Shanghai"),
  status: z.enum(["complete", "partial"]),
  items: z.array(newsItemSchema).max(30),
  metrics: editionMetricsSchema
});

export type Category = (typeof categories)[number];
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type Edition = z.infer<typeof editionSchema>;

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
