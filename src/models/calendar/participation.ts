import type { Event } from "../calendar";
import { sameAscii } from "../text";
import { calendarEmail, fold, property, recurrence, uid, unfold } from "./ical";

const STATUSES = new Set(["ACCEPTED", "DECLINED", "TENTATIVE", "NEEDS-ACTION", "DELEGATED"]);

function block(event: Event, lines: string[]) {
  const selected = uid(lines) === event.uid && recurrence(lines) === event.recurrenceId;
  return lines
    .map((line) => {
      const found = selected ? property(line) : null;
      if (!found || !sameAscii(found[0], "ATTENDEE")) return fold(line);
      const [, head, value] = found;
      const email = calendarEmail(value);
      const attendee = email === null ? undefined : event.attendees.find((attendee) => sameAscii(attendee.email, email));
      return attendee && STATUSES.has(attendee.status) ? fold(`${head.replace(/;PARTSTAT=[^;]*/i, "")};PARTSTAT=${attendee.status}:${value}`) : fold(line);
    })
    .join("");
}

export function calendarWithStatuses(event: Event, calendar: string) {
  let result = "";
  let current: string[] | null = null;
  for (const line of unfold(calendar)) {
    if (current === null) {
      if (!sameAscii(line, "BEGIN:VEVENT")) {
        result += fold(line);
        continue;
      }
      current = [];
    }
    current.push(line);
    if (sameAscii(line, "END:VEVENT")) {
      result += block(event, current);
      current = null;
    }
  }
  return current === null ? result : result + block(event, current);
}
