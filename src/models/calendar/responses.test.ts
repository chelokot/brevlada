import { expect, test } from "bun:test";
import { message } from "..";
import { type Attendee, compactReply, event as create, type Event, participants, snapshot } from "../calendar";

test("connects genuine replies and preserves other mail", () => {
  const event = create({
    uid: "meeting",
    method: "REQUEST",
    organizerEmail: "host@example.com",
    attendees: [{ email: "me@example.com", name: null, status: "TENTATIVE" }],
  });
  const reply = (stamp: number) =>
    message({ uid: stamp, messageId: `reply-${stamp}`, sender: "Me <me@example.com>", bodyLoaded: true, calendarEvents: [{ ...event, method: "REPLY", stamp }] });
  const [old, current] = [reply(1), reply(2)];
  const people = participants(event, [old, current, current]);
  expect(people.length).toBe(1);
  expect(people[0]?.attendee).toMatchObject({ status: "TENTATIVE", name: "Me" });
  expect(people[0]?.respondedAt).toBe(2);
  expect(event.attendees[0]?.name).toBeNull();
  expect(compactReply(current, [event])).toBe(true);
  const header = { ...current, bodyLoaded: false };
  expect(compactReply(header, [event])).toBe(true);
  expect(compactReply({ ...header, calendarEvents: [] }, [event])).toBe(false);
  expect(compactReply(current, [])).toBe(false);
  const another = { ...event, uid: "another-meeting" };
  const combined = { ...current, calendarEvents: [...current.calendarEvents, { ...another, method: "REPLY" }] };
  expect(compactReply(combined, [event])).toBe(false);
  expect(compactReply(combined, [event, another])).toBe(true);
  const request = { ...combined, calendarEvents: [...current.calendarEvents, { ...another, method: "REQUEST" }] };
  expect(compactReply(request, [event])).toBe(false);
  expect(compactReply({ ...current, sender: "stranger@example.com" }, [event])).toBe(false);
  expect(compactReply({ ...current, attachments: ["notes.pdf"] }, [event])).toBe(false);
  const exception = current.calendarEvents.map((item): Event => ({ ...item, recurrenceId: "RECURRENCE-ID:20261003" }));
  expect(compactReply({ ...current, calendarEvents: exception }, [event])).toBe(false);
});

test("dates only the current response and ignores stale and forged replies", () => {
  const invited: Attendee = { email: "me@example.com", name: null, status: "NEEDS-ACTION" };
  const source = create({ uid: "meeting", organizerEmail: "host@example.com", stamp: 10, sequence: 2, method: "REQUEST", attendees: [invited] });
  const reply = (stamp: number, sequence: number, sender: string, status: string) =>
    message({ sender, calendarEvents: [{ ...source, method: "REPLY", stamp, sequence, attendees: [{ ...invited, status }] }] });
  const replies = [
    reply(20, 1, "me@example.com", "ACCEPTED"),
    reply(9, 2, "me@example.com", "ACCEPTED"),
    reply(12, 2, "me@example.com", "TENTATIVE"),
    reply(13, 2, "stranger@example.com", "DECLINED"),
  ];
  const people = participants(snapshot(source, replies), replies);
  expect(people[0]?.attendee.status).toBe("TENTATIVE");
  expect(people[0]?.respondedAt).toBe(12);
  const stale = replies.filter((_, index) => index !== 2);
  expect(participants(source, stale)[0]?.respondedAt).toBeNull();
});
