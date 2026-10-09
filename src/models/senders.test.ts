import { expect, test } from "bun:test";
import { message, threads } from ".";
import { groups, key, preview } from "./senders";

test("unread senders come first with newest first within each section", () => {
  const item = (uid: number, sender: string, isRead: boolean) => message({ uid, timestamp: uid, sender, isRead });
  const messages = [
    item(1, "mixed@example.com", false),
    item(5, "mixed@example.com", true),
    item(3, "unread@example.com", false),
    item(9, "read@example.com", true),
    item(7, "other-read@example.com", true),
  ];
  expect(groups(messages, "").map((group) => group[0]?.uid)).toEqual([5, 3, 9, 7]);
});

test("preview prefers first unread then latest read regardless of cached body", () => {
  const messages = [
    message({ uid: 1, timestamp: 1, sender: "sender@example.com", subject: "Older read message", isRead: true, bodyLoaded: true, bodyText: "Cached" }),
    message({ uid: 2, timestamp: 2, sender: "sender@example.com", subject: "Latest unread message" }),
  ];
  const [first, second] = messages;
  if (!first || !second) throw new Error("missing fixtures");
  const uid = (list: typeof messages) => preview(list)?.uid;
  expect(groups(messages, "")[0]?.[0]?.uid).toBe(2);
  expect(uid(messages)).toBe(2);
  first.isRead = false;
  second.isRead = true;
  expect(groups(messages, "")[0]?.[0]?.uid).toBe(2);
  expect(uid(messages)).toBe(1);
  expect(uid(groups(messages, "latest")[0] ?? [])).toBe(1);
  second.isRead = false;
  expect(uid(messages)).toBe(2);
  second.timestamp = first.timestamp;
  expect(uid(messages)).toBe(2);
  for (const item of messages) item.isRead = true;
  expect(uid(messages)).toBe(2);
  expect(preview([])).toBeNull();
});

test("groups mailboxes despite name changes and keeps latest preview when searching", () => {
  const item = (uid: number, sender: string, subject: string) => message({ uid, timestamp: uid, sender, subject });
  const messages = [item(1, "Old Name <ALICE@example.com>", "Find me"), item(3, "Alice <alice@example.com>", "Latest"), item(2, "Alice <other@example.com>", "Separate")];
  const grouped = groups(messages, "");
  expect(grouped.length).toBe(2);
  expect(grouped[0]?.map((entry) => entry.uid)).toEqual([3, 1]);
  expect(groups(messages, "find me")[0]?.[0]?.subject).toBe("Latest");
  expect(groups(messages, "missing")).toEqual([]);
  const filtered = messages.filter((entry) => key(entry) === "alice@example.com");
  expect(threads(filtered, "").flat().every((entry) => entry.uid !== 2)).toBe(true);
});
