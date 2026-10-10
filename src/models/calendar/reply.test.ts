import { expect, test } from "bun:test";
import { parseIcal, type Response, status } from "../calendar";
import { reply } from "./reply";

test("reply keeps identity and sends only the current attendee", () => {
  const raw =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting\r\nSEQUENCE:4\r\nRECURRENCE-ID:20261002T120000Z\r\nDTSTART:20261002T130000Z\r\nORGANIZER:mailto:host@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nATTENDEE:mailto:other@example.com\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const [event] = parseIcal(raw);
  if (!event) throw new Error("event expected");
  for (const response of ["Accepted", "Tentative", "Declined"] satisfies Response[]) {
    const source = reply(event, "me@example.com", response);
    const [parsed] = parseIcal(source);
    expect(parsed).toMatchObject({ uid: event.uid, recurrenceId: event.recurrenceId, sequence: 4, method: "REPLY" });
    expect(parsed?.attendees.map((attendee) => attendee.status)).toEqual([status(response)]);
    expect(source).not.toContain("VALARM");
  }
  expect(() => reply(event, "stranger@example.com", "Accepted")).toThrow("This account is not an attendee of this invitation");
  expect(() => reply({ ...event, recurrenceId: null }, "me@example.com", "Accepted")).toThrow("The requested event instance is unavailable");
});
