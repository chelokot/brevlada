import { expect, test } from "bun:test";
import { message } from "..";
import { event as create, type Response, snapshot, status } from "../calendar";

test("correlates replies by uid, instance, sequence and sender", () => {
  const event = create({
    uid: "one",
    name: "Meeting",
    start: "2026-10-02T12:00:00Z",
    organizerEmail: "host@example.com",
    method: "REQUEST",
    sequence: 2,
    stamp: 20,
    attendees: [{ email: "me@example.com", name: null, status: "NEEDS-ACTION" }],
  });
  const response = (sender: string, sequence: number, stamp: number, answer: Response) =>
    message({
      sender,
      timestamp: stamp,
      calendarEvents: [{ ...event, method: "REPLY", sequence, stamp, attendees: [{ email: "me@example.com", name: null, status: status(answer) }] }],
    });
  const messages = [
    response("me@example.com", 1, 99, "Declined"),
    response("me@example.com", 2, 21, "Accepted"),
    response("stranger@example.com", 2, 23, "Declined"),
    response("me@example.com", 2, 22, "Tentative"),
  ];
  expect(snapshot(event, messages).attendees[0]?.status).toBe("TENTATIVE");
  expect(event.attendees[0]?.status).toBe("NEEDS-ACTION");
  const [, accepted] = messages;
  if (!accepted) throw new Error("message expected");
  const exception = { ...accepted, calendarEvents: accepted.calendarEvents.map((item) => ({ ...item, recurrenceId: "RECURRENCE-ID:20261003T120000Z" })) };
  expect(snapshot(event, [exception]).attendees[0]?.status).toBe("NEEDS-ACTION");
});

test("keeps the roster and updates each invitee's own response", () => {
  const event = create({
    uid: "meeting",
    organizerEmail: "host@example.com",
    method: "REQUEST",
    stamp: 10,
    attendees: ["me@example.com", "alex@example.com", "sam@example.com"].map((email) => ({ email, name: null, status: "NEEDS-ACTION" })),
  });
  const reply = (email: string, answer: Response) =>
    message({ sender: email, calendarEvents: [{ ...event, method: "REPLY", stamp: 11, attendees: [{ email, name: null, status: status(answer) }] }] });
  const updated = snapshot(event, [reply("alex@example.com", "Accepted"), reply("sam@example.com", "Declined")]);
  expect(updated.attendees.map((attendee) => attendee.status)).toEqual(["NEEDS-ACTION", "ACCEPTED", "DECLINED"]);
});

test("cancellations close the invitation", () => {
  const event = create({ uid: "meeting", organizerEmail: "host@example.com", method: "REQUEST", invitation: true });
  const cancelled = snapshot(event, [message({ calendarEvents: [{ ...event, method: "CANCEL", sequence: 1 }] })]);
  expect(cancelled).toMatchObject({ status: "CANCELLED", invitation: false });
});
