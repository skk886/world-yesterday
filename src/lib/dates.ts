const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function formatShanghaiDate(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function previousShanghaiDate(now = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

export function shanghaiDayWindow(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(`${date}T23:59:59.999+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid Asia/Shanghai date: ${date}`);
  }
  return { start, end };
}

export function dateIsInShanghaiDay(value: string | Date, date: string): boolean {
  const instant = value instanceof Date ? value : new Date(value);
  const { start, end } = shanghaiDayWindow(date);
  return instant >= start && instant <= end;
}

export function formatEditionDate(date: string): { zh: string; en: string } {
  const value = new Date(`${date}T12:00:00+08:00`);
  return {
    zh: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(value),
    en: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Shanghai" }).format(value)
  };
}

export function enumerateDatesNewestFirst(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  const dates: string[] = [];
  for (let cursor = new Date(end); cursor >= start; cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}
