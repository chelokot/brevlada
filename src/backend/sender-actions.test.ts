import { expect, test } from "bun:test";
import type { SenderAction } from "../models/sender-action";
import { Session } from "./imap";
import { parse } from "./parser";
import { apply, applyUids, fallbackFolder, undoMessage } from "./sender-actions";
import { Stream } from "./stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fetched = (sequence: number, uid: number, header: string) =>
  `* ${sequence} FETCH (UID ${uid} BODY[HEADER] {${encoder.encode(header).length}}\r\n${header})\r\n`;

async function scripted(responses: string) {
  let commands = "";
  const closed = Promise.withResolvers<void>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        if (!commands) socket.write(`a1 OK login\r\n${responses}`);
        commands += decoder.decode(data);
      },
      close: () => closed.resolve(),
    },
  });
  const stream = await Stream.connect("127.0.0.1", server.port);
  const session = new Session(stream);
  await session.login("test", "test");
  const sent = async () => {
    stream.close();
    await closed.promise;
    server.stop(true);
    return commands;
  };
  return { session, sent };
}

test("marks only exact sender matches, including older messages", async () => {
  const { session, sent } = await scripted(
    "* OK [UIDVALIDITY 7] valid\r\na2 OK select\r\n* SEARCH 1 90\r\na3 OK search\r\n" +
      fetched(1, 1, "From: Alice <alice@example.com>\r\n\r\n") +
      fetched(2, 90, "From: Other <not-alice@example.com>\r\n\r\n") +
      "a4 OK fetch\r\n* OK [UIDVALIDITY 7] valid\r\na5 OK select\r\na6 OK store\r\n",
  );
  await apply(session, "INBOX", "alice@example.com", { kind: "MarkRead" });
  const commands = await sent();
  expect(commands).toContain("UID STORE 1 +FLAGS.SILENT (\\Seen)");
  expect(commands).not.toContain("UID STORE 90");
});

test("moves to special use folders and marks spam before moving", async () => {
  for (const [kind, special] of [
    ["Archive", "\\Archive"],
    ["Delete", "\\Trash"],
    ["Spam", "\\Junk"],
  ] as const) {
    const { session, sent } = await scripted(
      "* OK [UIDVALIDITY 7] valid\r\na2 OK select\r\n* SEARCH 1\r\na3 OK search\r\n" +
        fetched(1, 1, "From: Alice <alice@example.com>\r\n\r\n") +
        `a4 OK fetch\r\n* LIST (${special}) "/" "Localized"\r\na5 OK list\r\n* CAPABILITY IMAP4rev1 MOVE\r\na6 OK capability\r\n` +
        "* OK [UIDVALIDITY 7] valid\r\na7 OK select\r\na8 OK mutation\r\na9 OK mutation\r\na10 OK mutation\r\n",
    );
    await apply(session, "INBOX", "alice@example.com", { kind });
    const commands = await sent();
    expect(commands).toContain('UID MOVE 1 "Localized"');
    expect(commands).not.toContain("EXPUNGE");
    if (kind === "Spam") expect(commands.indexOf("+FLAGS.SILENT ($Junk)")).toBeLessThan(commands.indexOf("UID MOVE"));
    else expect(commands).not.toContain("$Junk");
  }
});

test("unread and stars only change the requested flag", async () => {
  for (const [kind, flag] of [
    ["MarkUnread", "-FLAGS.SILENT (\\Seen)"],
    ["Star", "+FLAGS.SILENT (\\Flagged)"],
    ["Unstar", "-FLAGS.SILENT (\\Flagged)"],
  ] as const) {
    const { session, sent } = await scripted("* OK [UIDVALIDITY 7] valid\r\na2 OK select\r\na3 OK store\r\n");
    expect(await applyUids(session, "INBOX", 7, [1, 2], { kind })).toBeTrue();
    const commands = await sent();
    expect(commands).toContain(`UID STORE 1,2 ${flag}`);
    expect(commands).not.toMatch(/MOVE|COPY|EXPUNGE/);
  }
});

test("restore and unspam move to the inbox and unspam clears junk", async () => {
  for (const kind of ["Restore", "Unspam"] as const) {
    const { session, sent } = await scripted(
      "* CAPABILITY IMAP4rev1 MOVE\r\na2 OK capabilities\r\n* OK [UIDVALIDITY 7] valid\r\na3 OK select\r\na4 OK mutation\r\na5 OK mutation\r\na6 OK mutation\r\n",
    );
    expect(await applyUids(session, "Trash", 7, [8], { kind })).toBeTrue();
    const commands = await sent();
    expect(commands).toContain('UID MOVE 8 "INBOX"');
    if (kind === "Unspam") {
      expect(commands.indexOf("-FLAGS.SILENT ($Junk)")).toBeLessThan(commands.indexOf("+FLAGS.SILENT ($NotJunk)"));
      expect(commands.indexOf("+FLAGS.SILENT ($NotJunk)")).toBeLessThan(commands.indexOf("UID MOVE"));
    } else expect(commands).not.toMatch(/\$Junk|\$NotJunk/);
  }
});

test("move to validates the folder and uses a scoped UIDPLUS fallback", async () => {
  const moveTo: SenderAction = { kind: "MoveTo", folder: "Work" };
  const fallback = await scripted(
    '* LIST () "/" "Work"\r\na2 OK list\r\n* CAPABILITY IMAP4rev1 UIDPLUS\r\na3 OK capabilities\r\n' +
      "* OK [UIDVALIDITY 7] valid\r\na4 OK select\r\na5 OK copy\r\na6 OK store\r\na7 OK expunge\r\n",
  );
  expect(await applyUids(fallback.session, "INBOX", 7, [2], moveTo)).toBeTrue();
  const commands = await fallback.sent();
  expect(commands).toContain('UID COPY 2 "Work"');
  expect(commands).toContain("UID STORE 2 +FLAGS.SILENT (\\Deleted)");
  expect(commands).toContain("UID EXPUNGE 2");
  const unselectable = await scripted('* LIST (\\Noselect) "/" "Work"\r\na2 OK list\r\n');
  await expect(applyUids(unselectable.session, "INBOX", 7, [2], moveTo)).rejects.toThrow("Destination folder is not selectable; refresh and retry");
  expect(await unselectable.sent()).not.toMatch(/UID COPY|UID STORE/);
});

const header = "From: Alice <alice@example.com>\r\nSubject: Plans\r\nMessage-ID: <one>\r\n\r\n";
const original = parse(1, encoder.encode(header), true, false);

test("undoing spam uses the new spam UID and restores the original folder", async () => {
  const { session, sent } = await scripted(
    "* OK [UIDVALIDITY 12] valid\r\na2 OK select\r\n* SEARCH 91\r\na3 OK search\r\n" +
      fetched(1, 91, header) +
      "a4 OK fetch\r\n* OK [UIDVALIDITY 12] valid\r\na5 OK select\r\na6 OK store\r\na7 OK store\r\n" +
      '* LIST () "/" "Work"\r\na8 OK list\r\n* CAPABILITY IMAP4rev1 MOVE\r\na9 OK capability\r\n* OK [UIDVALIDITY 12] valid\r\na10 OK select\r\na11 OK move\r\n',
  );
  expect((await undoMessage(session, "Junk", "Work", original)).uid).toBe(91);
  const commands = await sent();
  for (const command of [
    'UID SEARCH HEADER Message-ID "one"',
    "UID STORE 91 -FLAGS.SILENT ($Junk)",
    "UID STORE 91 +FLAGS.SILENT ($NotJunk)",
    'UID MOVE 91 "Work"',
  ]) {
    expect(commands).toContain(command);
  }
  expect(commands).not.toMatch(/UID MOVE 1 |EXPUNGE/);
});

test("undoing spam refuses ambiguous matches and changed mailboxes", async () => {
  const ambiguous = await scripted(
    "* OK [UIDVALIDITY 12] valid\r\na2 OK select\r\n* SEARCH 91 92\r\na3 OK search\r\n" + fetched(1, 91, header) + fetched(2, 92, header) + "a4 OK fetch\r\n",
  );
  await expect(undoMessage(ambiguous.session, "Junk", "Work", original)).rejects.toThrow(
    "Could not uniquely identify this message in Spam; open the Spam folder to restore it",
  );
  expect(await ambiguous.sent()).not.toMatch(/UID STORE|UID MOVE/);
  const changed = await scripted(
    "* OK [UIDVALIDITY 12] valid\r\na2 OK select\r\n* SEARCH 91\r\na3 OK search\r\n" +
      fetched(1, 91, header) +
      "a4 OK fetch\r\n* OK [UIDVALIDITY 13] changed\r\na5 OK select\r\n",
  );
  await expect(undoMessage(changed.session, "Junk", "Work", original)).rejects.toThrow("Spam mailbox changed; refresh and retry");
  expect(await changed.sent()).not.toMatch(/UID STORE|UID MOVE/);
});

test("spam does not fall back to trash or expunge existing spam", async () => {
  const trashOnly = await scripted('* LIST (\\Trash) "/" "Trash"\r\na2 OK list\r\n');
  await expect(applyUids(trashOnly.session, "INBOX", 7, [1], { kind: "Spam" })).rejects.toThrow("Could not find the account's Spam folder");
  expect(await trashOnly.sent()).not.toMatch(/UID STORE|UID MOVE/);
  const inSpam = await scripted('* LIST (\\Junk) "/" "Spam"\r\na2 OK list\r\n* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\na3 OK capabilities\r\n');
  expect(await applyUids(inSpam.session, "Spam", 7, [1], { kind: "Spam" })).toBeFalse();
  expect(await inSpam.sent()).not.toMatch(/UID STORE|EXPUNGE/);
});

test("distinguishes archive and trash names", () => {
  expect(fallbackFolder("All Mail", { kind: "Archive" })).toBeTrue();
  expect(fallbackFolder("Junk", { kind: "Spam" })).toBeTrue();
  expect(fallbackFolder("Deleted Items", { kind: "Spam" })).toBeFalse();
  expect(fallbackFolder("Junk", { kind: "Delete" })).toBeFalse();
  expect(fallbackFolder("Trash", { kind: "Archive" })).toBeFalse();
});
