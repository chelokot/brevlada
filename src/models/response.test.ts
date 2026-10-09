import { expect, test } from "bun:test";
import { message } from ".";
import { forwardHeader, recipients, subject } from "./response";

const original = message({
  sender: "Sender <sender@example.com>",
  replyTo: "Support <support@example.com>, Backup <backup@example.com>",
  recipients: "Me <ME@example.com>, Support <SUPPORT@example.com>, Team: Alice <alice@example.com>, Bob <bob@example.com>;",
  cc: "Alice <ALICE@example.com>, Copy <copy@example.com>, me@example.com",
});

test("reply honors all reply-to addresses and falls back to from", () => {
  expect(recipients(original, "me@example.com", "Reply")).toEqual(['"Support" <support@example.com>, "Backup" <backup@example.com>', ""]);
  for (const replyTo of ["", "invalid <"]) expect(recipients({ ...original, replyTo }, "me@example.com", "Reply")[0]).toBe('"Sender" <sender@example.com>');
});

test("reply all flattens groups, deduplicates and excludes self", () => {
  const [to, cc] = recipients(original, "me@example.com", "ReplyAll");
  expect(to).toBe('"Support" <support@example.com>, "Backup" <backup@example.com>, "Alice" <alice@example.com>, "Bob" <bob@example.com>');
  expect(cc).toBe('"Copy" <copy@example.com>');
});

test("own messages reply to original recipients", () => {
  const [to, cc] = recipients({ ...original, sender: "ME@example.com" }, "me@example.com", "ReplyAll");
  expect(to).toContain("SUPPORT@example.com");
  expect(to).not.toContain("backup@example.com");
  expect(to).not.toContain("ME@example.com");
  expect(cc).toBe('"Copy" <copy@example.com>');
});

test("forward starts without recipients and does not repeat prefixes", () => {
  const forwarded = { ...original, subject: " FW: Plans " };
  expect(recipients(forwarded, "me@example.com", "Forward")).toEqual(["", ""]);
  expect(subject(forwarded, "Forward")).toBe("FW: Plans");
  expect(subject(forwarded, "Reply")).toBe("Re: FW: Plans");
  expect(forwardHeader(forwarded)).toContain("From: Sender <sender@example.com>");
  expect(forwardHeader(forwarded)).toContain("Cc: Alice");
});
