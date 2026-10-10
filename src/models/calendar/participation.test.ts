import { expect, test } from "bun:test";
import { parseIcal, toIcal } from "../calendar";

test("exports updated attendance without changing other instances", () => {
  const source =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261002T120000Z\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20261003T120000Z\r\nDTSTART:20261003T130000Z\r\nATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const [, event] = parseIcal(source);
  if (!event) throw new Error("event expected");
  const parsed = parseIcal(toIcal({ ...event, attendees: event.attendees.map((attendee) => ({ ...attendee, status: "ACCEPTED" })) }) ?? "");
  expect(parsed.length).toBe(2);
  expect(parsed[0]?.attendees[0]?.status).toBe("NEEDS-ACTION");
  expect(parsed[1]?.attendees[0]).toMatchObject({ status: "ACCEPTED", name: "Me" });
});
