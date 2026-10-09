import { expect, test } from "bun:test";
import { scripted } from "./testing";
import { fetch } from "./mail-headers";

test("ignores unsolicited flags and unrequested headers", async () => {
  const header = "From: Alice <alice@example.com>\r\nMessage-ID: <one>\r\n\r\n";
  const { session, sent } = await scripted(
    `* 2 FETCH (FLAGS (\\Seen))\r\n* 3 FETCH (UID 3 FLAGS (\\Seen))\r\n* 1 FETCH (UID 1 FLAGS () BODY[HEADER] {${header.length}}\r\n${header})\r\n` +
      `* 9 FETCH (UID 9 FLAGS () BODY[HEADER] {${header.length}}\r\n${header})\r\na2 OK fetch\r\n`,
  );
  const messages = await fetch(session, "INBOX", null, 7, [1, 4]);
  expect(messages.map(({ uid, messageId, uidValidity }) => [uid, messageId, uidValidity])).toEqual([[1, "one", 7]]);
  expect(await sent()).toContain("a2 UID FETCH 1,4 (UID FLAGS BODY.PEEK[HEADER])\r\n");
});
