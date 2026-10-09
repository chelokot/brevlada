import { canReply, type Event, type Response, status } from "../calendar";
import { asciiUpper, sameAscii } from "../text";
import { stamp } from "./export";
import { fold, property, recurrence, uid, unfold } from "./ical";

const KEPT = new Set(["UID", "ORGANIZER", "SEQUENCE", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "SUMMARY", "LOCATION", "RRULE", "RDATE", "EXDATE"]);

export function reply(event: Event, email: string, response: Response) {
  if (!canReply(event, email)) throw new Error("This account is not an attendee of this invitation");
  if (event.calendar === null) throw new Error("Invitation data is unavailable");
  const lines = unfold(event.calendar);
  const result = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Brevlada//Calendar//EN", "METHOD:REPLY"];
  let timezone = false;
  for (const line of lines) {
    if (sameAscii(line, "BEGIN:VTIMEZONE")) timezone = true;
    if (timezone) result.push(line);
    if (sameAscii(line, "END:VTIMEZONE")) timezone = false;
  }
  let block: string[] = [];
  let inside = false;
  let selected: string[] | null = null;
  for (const line of lines) {
    if (sameAscii(line, "BEGIN:VEVENT")) inside = true;
    if (inside) block.push(line);
    if (sameAscii(line, "END:VEVENT") && inside) {
      if (uid(block) === event.uid && recurrence(block) === event.recurrenceId) {
        selected = block;
        break;
      }
      block = [];
      inside = false;
    }
  }
  if (selected === null) throw new Error("The requested event instance is unavailable");
  result.push("BEGIN:VEVENT");
  let depth = 0;
  for (const line of selected.slice(1, -1)) {
    const found = property(line);
    if (!found) continue;
    const key = asciiUpper(found[0]);
    if (key === "BEGIN") depth++;
    else if (key === "END") depth--;
    else if (depth === 0 && KEPT.has(key)) result.push(line);
  }
  result.push(
    stamp(),
    `ATTENDEE;PARTSTAT=${status(response)}:mailto:${email}`,
    "REQUEST-STATUS:2.0;Success",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return result.map(fold).join("");
}
