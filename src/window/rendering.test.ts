import { expect, test } from "bun:test";
import { message } from "../models";
import { event } from "../models/calendar";
import { sameRow } from "./rendering";

test("reply classification and older preview updates refresh the thread row", () => {
  const latest = message({ uid: 2, bodyText: "Accepted: Lunch" });
  const reply = { ...latest, calendarEvents: [event({ method: "REPLY" })] };
  const original = message({ uid: 1, bodyText: "Join us" });
  expect(sameRow([latest, original], [reply, original], true)).toBe(false);
  expect(sameRow([reply, original], [reply, { ...original, bodyText: "Join us for lunch" }], true)).toBe(false);
});

test("read revisions do not replace visually unchanged threads", () => {
  const read = message({ uid: 1, isRead: true, readRevision: 1 });
  const updated = { ...read, readRevision: 2 };
  expect(sameRow([read], [updated], true)).toBe(true);
  expect(sameRow([read], [{ ...updated, isRead: false }], true)).toBe(false);
});

test("additional matches refresh the sender count without changing the preview", () => {
  const latest = message({ uid: 2, timestamp: 2, sender: "sender@example.com", subject: "First match", searchMatch: true, isRead: true });
  const older = { ...latest, uid: 1, timestamp: 1, subject: "Second match" };
  expect(sameRow([latest], [latest, older], false)).toBe(false);
});

test("older mail does not replace an unchanged sender row", () => {
  const latest = message({ uid: 2, timestamp: 2, sender: "a@example.com", subject: "Latest", isRead: true });
  const older = message({ uid: 1, timestamp: 1, sender: latest.sender, subject: "Older", isRead: true });
  expect(sameRow([latest], [latest, older], false)).toBe(true);
  expect(sameRow([latest], [latest, older], true)).toBe(false);
  const unreadOlder = { ...older, isRead: false };
  expect(sameRow([{ ...latest, isRead: false }, unreadOlder], [latest, unreadOlder], false)).toBe(false);
  expect(sameRow([latest, unreadOlder], [latest, { ...unreadOlder, subject: "Updated unread subject" }], false)).toBe(false);
  expect(sameRow([latest, unreadOlder], [latest, older], false)).toBe(false);
});
