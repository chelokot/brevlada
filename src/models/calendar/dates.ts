import type { Event } from "../calendar";
import { addDays, compareNaive, format, local, parse, rfc3339, type Time, timestamp } from "../time";

const DAY = "%a, %e %b %Y";

function timedRange(start: Time, end: Time | null, zone: string | null) {
  let label = format(start, `${DAY} · %H:%M`);
  if (end && compareNaive(end, start) !== 0) label += start.days === end.days ? `–${format(end, "%H:%M")}` : ` – ${format(end, `${DAY} · %H:%M`)}`;
  return zone === null ? label : `${label} (${zone})`;
}

export function label({ start, end, calendar, timezone }: Event) {
  const startDate = parse(start, "%Y-%m-%d");
  if (startDate) {
    const endDate = end === null ? null : parse(end, "%Y-%m-%d");
    const last = endDate && calendar !== null ? addDays(endDate, -1) : endDate;
    const range = last && last.days > startDate.days ? ` – ${format(last, DAY)}` : "";
    return `${format(startDate, DAY)}${range} · All day`;
  }
  const zoned = rfc3339(start);
  if (zoned) {
    const finish = end === null ? null : rfc3339(end);
    return timedRange(local(timestamp(zoned), zoned.nano), finish && local(timestamp(finish), finish.nano), null);
  }
  const naive = parse(start, "%Y-%m-%dT%H:%M:%S");
  return naive ? timedRange(naive, end === null ? null : parse(end, "%Y-%m-%dT%H:%M:%S"), timezone) : start;
}
