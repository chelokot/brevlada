import { format, parse, rfc3339, toRfc3339 } from "../time";

const dateTime = (value: string) => parse(value, "%Y-%m-%dT%H:%M:%S") ?? parse(value, "%Y-%m-%dT%H:%M");

export function normalize(value: string) {
  const date = rfc3339(value) ?? parse(value, "%Y-%m-%dT%H:%M:%S%z");
  return date ? toRfc3339(date) : value;
}

export function dateLabel(value: string) {
  const zoned = rfc3339(value);
  if (zoned) return format(zoned, "%a, %-d %b %Y · %H:%M (UTC%:z)");
  const naive = dateTime(value);
  if (naive) return format(naive, "%a, %-d %b %Y · %H:%M");
  const date = parse(value, "%Y-%m-%d");
  return date ? format(date, "%a, %-d %b %Y") : value;
}

export function dayLabel(value: string) {
  const date = rfc3339(value) ?? dateTime(value) ?? parse(value, "%Y-%m-%d");
  return date ? format(date, "%-d %b %Y") : value;
}

export function timeLabel(value: string) {
  const date = rfc3339(value) ?? dateTime(value);
  return date ? format(date, "%H:%M") : null;
}
