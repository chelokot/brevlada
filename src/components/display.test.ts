import { expect, test } from "bun:test";
import { message } from "../models";
import { date, senderName, subject } from "./display";

test("labels senders, subjects and dates like the Rust list", () => {
  expect(senderName(message({ sender: '"Alice" <alice@example.com>' }))).toBe("Alice");
  expect(senderName(message({ sender: "alice@example.com" }))).toBe("alice@example.com");
  expect(senderName(message())).toBe("Unknown Sender");
  expect(subject(message({ subject: "RE: Fwd:  回复: Plans " }))).toBe("Plans");
  expect(subject(message({ subject: "Re: " }))).toBe("(No Subject)");
  const old = message({ timestamp: Date.UTC(2020, 0, 2, 12) / 1000 });
  expect(date(old, false)).toBe("Jan 02, 2020");
  expect(date(old, true)).toMatch(/^01\/02\/20 \d\d:\d\d$/);
  const now = message({ timestamp: Math.floor(Date.now() / 1000) });
  expect(date(now, true)).toMatch(/^Today \d\d:\d\d$/);
  expect(date({ ...now, timestamp: now.timestamp - 86400 }, false)).toBe("Yesterday");
  expect(date({ ...now, timestamp: now.timestamp + 86400 * 3 }, false)).toMatch(/^\w{3} \d\d, \d{4}$/);
});
