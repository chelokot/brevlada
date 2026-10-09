import { expect, test } from "bun:test";
import { message, threads } from ".";

test("long subject history does not recurse through parent chain", () => {
  const groups = threads(Array.from({ length: 20000 }, (_, index) => message({ uid: index + 1, subject: "Same topic" })), "");
  expect(groups.length).toBe(1);
  expect(groups[0]?.length).toBe(20000);
});

test("joins reference bridges and sorts unread first", () => {
  const groups = threads(
    [
      message({ uid: 1, messageId: "a", timestamp: 1, subject: "First", isRead: true }),
      message({ uid: 2, messageId: "b", timestamp: 3, subject: "Second", isRead: true }),
      message({ uid: 3, timestamp: 2, references: ["a", "b"], subject: "Bridge" }),
      message({ uid: 4, subject: "Separate", isRead: true, timestamp: 100 }),
    ],
    "",
  );
  expect(groups.length).toBe(2);
  expect(groups[0]?.map((item) => item.uid)).toEqual([2, 3, 1]);
});

test("normalizes repeated reply prefixes and searches sender", () => {
  const messages = [message({ subject: "Topic", sender: "Alice" }), message({ subject: "Re: Fwd: Topic" })];
  expect(threads(messages, "").length).toBe(1);
  expect(threads(messages, "alice")[0]?.length).toBe(1);
  expect(threads(messages, "missing")).toEqual([]);
});

test("shared reference without matching message does not join threads", () => {
  const messages = [message({ uid: 1, subject: "One", references: ["missing"] }), message({ uid: 2, subject: "Two", references: ["missing"] })];
  expect(threads(messages, "").length).toBe(2);
  expect(threads([...messages, message({ uid: 3, messageId: "missing", subject: "Three" })], "").length).toBe(1);
});
