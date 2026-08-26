import fs from "node:fs";
import path from "node:path";
import { editionSchema, type Edition } from "./schema";
import { previousShanghaiDate } from "./dates";

const editionsDirectory = path.resolve("data/editions");

export function loadEditions(): Edition[] {
  if (process.env.DEMO_CONTENT === "true") {
    const demoPath = path.resolve("data/demo/edition.json");
    return [editionSchema.parse(JSON.parse(fs.readFileSync(demoPath, "utf8")))];
  }
  if (!fs.existsSync(editionsDirectory)) return [];
  return fs.readdirSync(editionsDirectory)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => editionSchema.parse(JSON.parse(fs.readFileSync(path.join(editionsDirectory, name), "utf8"))))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function loadRawDates(): string[] {
  const rawDirectory = path.resolve("data/raw");
  if (!fs.existsSync(rawDirectory)) return [];
  return fs.readdirSync(rawDirectory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => b.localeCompare(a));
}

export function getMissingEditionDates(editions: Edition[]): string[] {
  const published = new Set(editions.map((edition) => edition.date));
  return loadRawDates().filter((date) => !published.has(date));
}

export function getEdition(date: string): Edition | undefined {
  return loadEditions().find((edition) => edition.date === date);
}

export function getSiteFreshness(editions: Edition[], now = new Date()) {
  const expectedDate = previousShanghaiDate(now);
  const latestDate = editions[0]?.date;
  return {
    expectedDate,
    latestDate,
    isCurrent: latestDate === expectedDate,
    hasEdition: Boolean(latestDate),
    missingLatest: latestDate !== expectedDate
  };
}
