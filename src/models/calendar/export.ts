import type { Event } from "../calendar";
import { fold } from "./ical";
import { calendarWithStatuses } from "./participation";
import { addDays, compare, compareNaive, format, fromTimestamp, parse, rfc3339, timestamp } from "../time";

const escape = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n").replaceAll(";", "\;").replaceAll(",", "\\,");

const utc = (value: number) => format(fromTimestamp(value), "%Y%m%dT%H%M%SZ");

export const stamp = () => `DTSTAMP:${utc(Math.floor(Date.now() / 1000))}`;

function dateProperty(key: string, value: string) {
  const day = parse(value, "%Y-%m-%d");
  if (day) return `${key};VALUE=DATE:${format(day, "%Y%m%d")}`;
  const zoned = rfc3339(value);
  if (zoned) return `${key}:${utc(timestamp(zoned))}`;
  const naive = parse(value, "%Y-%m-%dT%H:%M:%S");
  return naive && `${key}:${format(naive, "%Y%m%dT%H%M%S")}`;
}

function endProperty(start: string, end: string) {
  const [startDay, endDay] = [parse(start, "%Y-%m-%d"), parse(end, "%Y-%m-%d")];
  if (endDay) return startDay && endDay.days >= startDay.days ? `DTEND;VALUE=DATE:${format(addDays(endDay, 1), "%Y%m%d")}` : null;
  if (startDay) return null;
  const [zonedStart, zonedEnd] = [rfc3339(start), rfc3339(end)];
  const [naiveStart, naiveEnd] = [parse(start, "%Y-%m-%dT%H:%M:%S"), parse(end, "%Y-%m-%dT%H:%M:%S")];
  const ordered =
    zonedStart && zonedEnd
      ? compare(zonedEnd, zonedStart) > 0
      : !zonedStart && !zonedEnd && naiveStart !== null && naiveEnd !== null && compareNaive(naiveEnd, naiveStart) > 0;
  return ordered ? dateProperty("DTEND", end) : null;
}

export function serialize(event: Event) {
  if (event.calendar !== null) return calendarWithStatuses(event, event.calendar);
  const start = dateProperty("DTSTART", event.start);
  if (start === null) return null;
  const end = event.end === null ? null : endProperty(event.start, event.end);
  if (event.end !== null && end === null) return null;
  const identity = `${event.name}\n${event.start}\n${event.location ?? ""}`;
  const uid = event.uid ?? `${new Bun.CryptoHasher("sha256").update(identity).digest("hex")}@brevlada`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Brevlada//Calendar//EN", "BEGIN:VEVENT", `UID:${escape(uid)}`, stamp(), start];
  if (end !== null) lines.push(end);
  lines.push(`SUMMARY:${escape(event.name)}`);
  if (event.location !== null) lines.push(`LOCATION:${escape(event.location)}`);
  if (event.description !== null) lines.push(`DESCRIPTION:${escape(event.description)}`);
  if (event.url !== null) lines.push(`URL:${event.url}`);
  if (event.status !== null && event.status.endsWith("EventCancelled")) lines.push("STATUS:CANCELLED");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("");
}
