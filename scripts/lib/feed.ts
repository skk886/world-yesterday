import { XMLParser } from "fast-xml-parser";

export type FeedEntry = {
  title: string;
  url: string;
  publishedAt?: string;
  updatedAt?: string;
  description?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  trimValues: true
});

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return text(record["#text"] ?? record["__cdata"]);
  }
  return undefined;
}

function link(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const alternate = value.find((entry) => entry?.["@_rel"] === "alternate") ?? value[0];
    return link(alternate);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return text(record["@_href"] ?? record["@_url"] ?? record["#text"]);
  }
  return undefined;
}

function cleanDescription(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function normalizeEntry(item: Record<string, unknown>): FeedEntry | undefined {
  const title = text(item.title);
  const url = link(item.link) ?? text(item.guid) ?? text(item.id);
  if (!title || !url || !/^https?:\/\//i.test(url)) return undefined;
  return {
    title,
    url,
    publishedAt: text(item.pubDate ?? item.published ?? item["dc:date"] ?? item.date),
    updatedAt: text(item.updated ?? item["atom:updated"]),
    description: cleanDescription(item.description ?? item.summary ?? item.content ?? item["content:encoded"])
  };
}

export function parseFeed(xml: string): FeedEntry[] {
  const document = parser.parse(xml) as Record<string, any>;
  const items = [
    ...arrayify(document.rss?.channel?.item),
    ...arrayify(document.feed?.entry),
    ...arrayify(document["rdf:RDF"]?.item)
  ];
  return items.map((item) => normalizeEntry(item)).filter((item): item is FeedEntry => Boolean(item));
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "WorldYesterday/0.1 (+https://github.com/; RSS research collector)",
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain;q=0.8"
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}
