import { expect, test } from "bun:test";
import { message } from "..";
import { events, sameEvent, toIcal } from "../calendar";
import { parse } from "./ical";

test("recurring request preserves each instance and saves the series", () => {
  const source =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261002T120000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Meeting\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20261003T120000Z\r\nDTSTART:20261003T130000Z\r\nSUMMARY:Moved meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const parsed = parse(source);
  expect(parsed.length).toBe(2);
  const [first, second] = parsed;
  if (!first || !second) throw new Error("events expected");
  expect(sameEvent(first, second)).toBe(false);
  expect(events(message({ calendarEvents: parsed })).length).toBe(2);
  for (const item of parsed) expect(parse(toIcal(item) ?? "").length).toBe(2);
});

test("preserves timezone, recurrence and attendees and ignores alarms", () => {
  const source =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART;TZID=Europe/Berlin:20261002T190000\r\nSUMMARY:Long\r\n  title\r\nRRULE:FREQ=WEEKLY\r\nORGANIZER;CN="Team: Calendar":mailto:team@example.com\r\nATTENDEE;RSVP=TRUE:mailto:me@example.com\r\nBEGIN:VALARM\r\nDESCRIPTION:Alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:two\r\nDTSTART;VALUE=DATE:20261003\r\nSUMMARY:Second\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const parsed = parse(source);
  expect(parsed.length).toBe(2);
  const [first] = parsed;
  expect(first).toMatchObject({ name: "Long title", organizer: "Team: Calendar", organizerEmail: "team@example.com", timezone: "Europe/Berlin", description: null, invitation: true });
  expect(first?.attendees).toEqual([{ email: "me@example.com", name: null, status: "NEEDS-ACTION" }]);
  const saved = (first && toIcal(first)) ?? "";
  expect(saved).toContain("RRULE:FREQ=WEEKLY");
  expect(saved).toContain("BEGIN:VTIMEZONE");
  expect(saved).toContain("ATTENDEE;RSVP=TRUE");
  expect(saved).not.toContain("UID:two");
  expect(parsed[1]?.start).toBe("2026-10-03");
});
