import { expect, test } from "bun:test";
import { scripted } from "./testing";
import { deliveryQuery, Mail } from "./mail";

test("delivery search quotes values and rejects missing ids and controls", () => {
  expect(deliveryQuery("shop@example.com", "123")).toBe('FROM "shop@example.com" TEXT "123"');
  expect(deliveryQuery("shop@example.com", 'a"b\\c')).toBe('FROM "shop@example.com" TEXT "a\\"b\\\\c"');
  for (const order of ["", "  ", "123\r\nALL"]) expect(() => deliveryQuery("shop@example.com", order)).toThrow();
});

test("reads status counts from the matching status response", async () => {
  const { session, sent } = await scripted("* STATUS INBOX (UNSEEN 3)\r\na2 OK STATUS completed\r\n* STATUS INBOX (UNSEEN 0)\r\na3 OK STATUS completed\r\n");
  const mail = new Mail(session);
  expect(await mail.hasUnread("inbox")).toBe(true);
  expect(await mail.hasUnread("INBOX")).toBe(false);
  expect(await sent()).toContain('a2 STATUS "inbox" (UNSEEN)\r\n');
});

test("ignores stale counts and other mailboxes", async () => {
  const { session, sent } = await scripted("* STATUS INBOX (UNSEEN 5)\r\na2 OK STATUS completed\r\n* STATUS Other (UNSEEN 9)\r\n* STATUS INBOX (MESSAGES 7)\r\na3 OK STATUS completed\r\n");
  await session.status("INBOX", "(UNSEEN)");
  await expect(new Mail(session).hasUnread("INBOX")).rejects.toThrow("Mail server did not return an unread count for the requested folder");
  await sent();
});
