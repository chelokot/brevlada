import { parse as addresses } from "../address";
import { event, type Event } from "../calendar";
import { asciiUpper, lines, sameAscii } from "../text";
import { format, parse as parseTime, rfc3339, timestamp } from "../time";

export function unescape(value: string) {
  return value.replace(/\\([\s\S]?)/gu, (_, char: string) => (char === "n" || char === "N" ? "\n" : char || "\\"));
}

export function fold(line: string) {
  let result = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += char;
    bytes += size;
  }
  return `${result}\r\n`;
}

export function property(line: string): [key: string, head: string, value: string] | null {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ":" && !quoted) {
      const head = line.slice(0, index);
      return [head.split(";")[0] ?? head, head, line.slice(index + 1)];
    }
  }
  return null;
}

export function parameter(head: string, key: string) {
  for (const part of head.split(";").slice(1)) {
    const split = part.indexOf("=");
    if (split >= 0 && sameAscii(part.slice(0, split), key)) return part.slice(split + 1).replace(/^"+|"+$/g, "");
  }
  return null;
}

export function date(value: string) {
  const day = parseTime(value, "%Y%m%d");
  if (day) return format(day, "%Y-%m-%d");
  const utc = value.endsWith("Z");
  const time = parseTime(utc ? value.slice(0, -1) : value, "%Y%m%dT%H%M%S");
  return time ? `${format(time, "%Y-%m-%dT%H:%M:%S")}${utc ? "Z" : ""}` : null;
}

export function calendarEmail(value: string) {
  if (!sameAscii(value.slice(0, 7), "mailto:")) return null;
  const email = value.slice(7);
  const [single, ...rest] = addresses(email) ?? [];
  const valid = single && !Array.isArray(single) && rest.length === 0 && single.addr === email && !/[\p{Cc}\p{White_Space}<>:,;?]/u.test(email);
  return valid ? email : null;
}

export const unfold = (source: string) => lines(source.replace(/\r?\n[ \t]/g, ""));

const find = (block: string[], key: string) => {
  for (const line of block) {
    const found = property(line);
    if (found && sameAscii(found[0], key)) return { line, value: found[2] };
  }
  return null;
};

export function uid(block: string[]) {
  const found = find(block, "UID");
  return found && unescape(found.value);
}

export function recurrence(block: string[]) {
  const found = find(block, "RECURRENCE-ID");
  return found && found.line;
}

function read(block: string[], properties: Pick<Event, "method" | "invitation">) {
  const result = event(properties);
  let depth = 0;
  for (const line of block.slice(1, -1)) {
    const found = property(line);
    if (!found) continue;
    const [key, head, value] = found;
    if (sameAscii(key, "BEGIN")) depth++;
    else if (sameAscii(key, "END")) depth--;
    else if (depth !== 0) continue;
    else
      switch (asciiUpper(key)) {
        case "UID":
          result.uid = unescape(value);
          break;
        case "RECURRENCE-ID":
          result.recurrenceId = line;
          break;
        case "SEQUENCE":
          result.sequence = /^\+?\d+$/.test(value) && Number(value) <= 0xffffffff ? Number(value) : 0;
          break;
        case "DTSTAMP": {
          const stamp = rfc3339(date(value) ?? "");
          result.stamp = stamp ? timestamp(stamp) : 0;
          break;
        }
        case "ATTENDEE": {
          const email = calendarEmail(value);
          if (email !== null) result.attendees.push({ email, name: parameter(head, "CN"), status: asciiUpper(parameter(head, "PARTSTAT") ?? "NEEDS-ACTION") });
          break;
        }
        case "SUMMARY":
          result.name = unescape(value);
          break;
        case "DTSTART":
          result.start = date(value) ?? "";
          result.timezone = parameter(head, "TZID");
          break;
        case "DTEND":
          result.end = date(value);
          break;
        case "LOCATION":
          result.location = unescape(value);
          break;
        case "ORGANIZER":
          result.organizerEmail = calendarEmail(value);
          result.organizer = parameter(head, "CN") ?? value.replace(/^(?:mailto:)+/, "");
          break;
        case "DESCRIPTION":
          result.description = unescape(value);
          break;
        case "URL":
          if (value.startsWith("https://") || value.startsWith("http://")) result.url = value;
          break;
        case "STATUS":
          result.status = value;
          break;
        case "REQUEST-STATUS":
          if (!value.startsWith("2.")) result.status = "REPLY-FAILED";
      }
  }
  return result;
}

export function parse(source: string): Event[] {
  const all = unfold(source);
  if (!sameAscii(all[0] ?? "", "BEGIN:VCALENDAR") || !sameAscii(all.at(-1) ?? "", "END:VCALENDAR")) return [];
  const methodLine = find(all, "METHOD");
  const method = methodLine && asciiUpper(methodLine.value);
  const invitation = all.some((line) => sameAscii(line, "METHOD:REQUEST"));
  const common: string[] = [];
  const blocks: string[][] = [];
  let current: string[] = [];
  let inside = false;
  for (const line of all.slice(1, -1)) {
    if (sameAscii(line, "BEGIN:VEVENT")) inside = true;
    (inside ? current : common).push(line);
    if (inside && sameAscii(line, "END:VEVENT")) {
      inside = false;
      blocks.push(current);
      current = [];
    }
  }
  return blocks.flatMap((block) => {
    const parsed = read(block, { method, invitation });
    if (!parsed.start && !((parsed.method === "REPLY" || parsed.method === "CANCEL") && parsed.uid !== null)) return [];
    if (parsed.status === "REPLY-FAILED") parsed.attendees = [];
    if (!parsed.name) parsed.name = "Calendar event";
    const related = blocks.filter((other) => uid(other) === parsed.uid && (parsed.uid !== null || other.join("\n") === block.join("\n")));
    parsed.calendar = ["BEGIN:VCALENDAR", ...common, ...related.flat(), "END:VCALENDAR"].map(fold).join("");
    return [parsed];
  });
}
