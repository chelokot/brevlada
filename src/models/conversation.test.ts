import { expect, test } from "bun:test";
import { message } from ".";
import { quotedMessageVisible, related } from "./conversation";

test("links sent replies and replies to sent by message id", () => {
  const received = [message({ messageId: "received", references: ["original-sent"] })];
  const sent = [
    { folder: "", message: message({ messageId: "reply-sent", references: ["received"] }) },
    { folder: "Sent", message: message({ messageId: "original-sent" }) },
    { folder: "Sent", message: message({ messageId: "unrelated", subject: "Same subject" }) },
  ];
  expect(related(received, sent).map((item) => item.message.messageId).sort()).toEqual(["original-sent", "reply-sent"]);
});

test("hides quotes only when the referenced message is below", () => {
  const original = message({ messageId: "original" });
  const reply = message({ references: ["original"] });
  expect(quotedMessageVisible(reply, [original])).toBe(true);
  expect(quotedMessageVisible(reply, [])).toBe(false);
  expect(quotedMessageVisible(original, [reply])).toBe(false);
});

test("includes own message with matching recipient and topic without reply headers", () => {
  const received = message({ messageId: "received", sender: "Other <other@example.com>", subject: "Re: Plans" });
  const sent = { folder: "Sent", message: message({ messageId: "sent", recipients: "other@example.com", subject: "Plans" }) };
  expect(related([received], [sent])).toEqual([sent]);
  expect(related([received], [{ ...sent, message: { ...sent.message, recipients: "someone@example.com" } }])).toEqual([]);
});
