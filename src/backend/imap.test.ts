import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Account, Draft } from "../models";
import { encode } from "./attachments";
import { BodyQueue } from "./body-queue";
import { Connections } from "./connections";
import { append, savedLocation } from "./draft-save";
import { forwardAttachments, removeUid, resolve } from "./drafts";
import { quote } from "./imap";
import { Mail } from "./mail";
import { parse } from "./parser";
import { draftMessage } from "./smtp";
import { Stream } from "./stream";
import { dovecot } from "./testing";

const bytes = (text: string) => new TextEncoder().encode(text);
const account: Account = { path: "", email: "me@example.com", name: "Me", host: "127.0.0.1", username: "test", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };
const large = new Uint8Array(1_500_000).map((_, index) => (index * 7919) % 251);
const seeds: [string, string[]][] = [
  [
    "From: Shop <shop@example.com>\r\nTo: me@example.com\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nMessage-ID: <one@example.com>\r\nDate: Thu, 8 Oct 2026 10:00:00 +0000\r\n" +
      "List-Unsubscribe: <https://example.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour order-123 has shipped. Ünïcödé\r\n",
    [],
  ],
  [
    "From: Friend <friend@example.com>\r\nSubject: Photos\r\nMessage-ID: <two@example.com>\r\nContent-Type: multipart/related; boundary=x\r\n\r\n--x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src=\"cid:logo\">\r\n" +
      `--x\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x\r\n${encode("résumé.pdf", "application/pdf", bytes("PDF"))}--x--\r\n`,
    ["\\Seen"],
  ],
  [`From: Big <big@example.com>\r\nSubject: Large\r\nMessage-ID: <three@example.com>\r\nContent-Type: multipart/mixed; boundary=y\r\n\r\n--y\r\n${encode("large.bin", "application/octet-stream", large)}--y--\r\n`, ["\\Flagged"]],
];

let server: Awaited<ReturnType<typeof dovecot>>;
beforeAll(async () => {
  server = await dovecot();
}, 30_000);
afterAll(() => server.stop());

test("logs in over implicit TLS and STARTTLS and surfaces server and certificate errors", async () => {
  for (const secure of [true, false]) {
    const session = await server.login("secret", secure);
    const capabilities = await session.capabilities();
    expect(["IMAP4rev1", "UIDPLUS", "MOVE"].filter((name) => capabilities.has(name))).toEqual(["IMAP4rev1", "UIDPLUS", "MOVE"]);
    await session.logout();
  }
  await expect(server.login("wrong")).rejects.toThrow("No Response: [AUTHENTICATIONFAILED] Authentication failed.");
  const stream = await Stream.connect("127.0.0.1", server.imaps);
  await expect(stream.upgrade("example.com")).rejects.toThrow("Hostname/IP does not match");
});

test("appends, syncs headers, loads bodies and updates flags through Mail", async () => {
  const mail = new Mail(await server.login());
  expect(await mail.folders()).toEqual(["Drafts", "INBOX", "Sent", "Trash"]);
  for (const [raw, flags] of seeds) await mail.session.appendWithFlags("INBOX", bytes(raw), flags);
  const [validity, messages, uids] = await mail.headers("INBOX");
  expect(uids).toEqual([1, 2, 3]);
  expect(messages.map(({ uid, subject, isRead, isFlagged, uidValidity, bodyLoaded }) => [uid, subject, isRead, isFlagged, uidValidity, bodyLoaded])).toEqual([
    [1, "Grüße", false, false, validity, false],
    [2, "Photos", true, false, validity, false],
    [3, "Large", false, true, validity, false],
  ]);
  expect(await mail.hasUnread("INBOX")).toBe(true);
  const photos = await mail.bodyWithValidity("INBOX", 2, validity, true);
  expect([photos.attachments, photos.inlineMedia.map(({ contentId }) => contentId), photos.bodyHtml]).toEqual([["résumé.pdf"], ["logo"], '<img src="cid:logo">']);
  expect((await mail.bodyWithValidity("INBOX", 3, validity, false)).attachmentDetails).toEqual([{ mime: "application/octet-stream", size: large.length, calendarRendered: false }]);
  expect((await mail.bodyWithValidity("INBOX", 1, null, false)).bodyText).toBe("Your order-123 has shipped. Ünïcödé\r\n");
  await expect(mail.bodyWithValidity("INBOX", 1, validity + 1, false)).rejects.toThrow("Mailbox changed while loading message");
  await expect(mail.bodyWithValidity("INBOX", 9, validity, false)).rejects.toThrow("Message is no longer on the server");
  expect((await mail.headerWithValidity("INBOX", 1, validity)).unsubscribe).toEqual({ url: "https://example.com/u", oneClick: true });
  expect(await mail.deliveryUids("INBOX", validity, "shop@example.com", "order-123")).toEqual([1]);
  for (const uid of uids) await mail.markRead("INBOX", uid, validity);
  expect(await mail.hasUnread("INBOX")).toBe(false);
  await mail.logout();
});

test("copies, moves and expunges by uid", async () => {
  const session = await server.login();
  await session.select("INBOX");
  await session.uidStore("1", "+FLAGS.SILENT (\\Seen)");
  await session.uidCopy("1", quote("Trash"));
  await session.uidMv("2", "Sent");
  await session.uidStore("3", "+FLAGS.SILENT (\\Deleted)");
  await session.uidExpunge("3");
  expect(await session.uidSearch("ALL")).toEqual([1]);
  expect(await session.status("Trash", "(MESSAGES UNSEEN)")).toEqual([{ mailbox: "Trash", attributes: new Map([["MESSAGES", 1], ["UNSEEN", 0]]) }]);
  expect((await session.examine("Sent")).exists).toBe(1);
  expect((await session.uidFetch("1:*", "(UID FLAGS)")).map(({ uid, flags }) => [uid, flags.includes("\\Seen")])).toEqual([[1, true]]);
  await session.logout();
});

test("saves, finds, forwards and deletes drafts on a UIDPLUS server", async () => {
  const session = await server.login();
  const draft: Draft = {
    attachmentsLoaded: true,
    to: "Other <unfinished",
    cc: "",
    subject: "Plan",
    text: "Draft",
    html: null,
    attachments: [encode("report.bin", "application/octet-stream", new Uint8Array([0, 255, 10]))],
    attachmentNames: ["report.bin"],
    removedAttachments: [],
    attachmentSource: null,
    inReplyTo: null,
    references: [],
  };
  const raw = bytes(draftMessage(account, draft));
  await append(session, "Drafts", raw);
  const id = parse(0, raw, true, true).messageId;
  const [validity, uid] = await savedLocation(session, "Drafts", id);
  expect(await resolve(session, { folder: "Drafts", uid: 0, validity: null, messageId: id })).toEqual([validity, uid]);
  const [part] = await forwardAttachments(session, { folder: "Drafts", uid: 0, validity: null, messageId: id }, []);
  expect(part).toContain("filename*0*=UTF-8''%72%65%70%6F%72%74%2E%62%69%6E");
  await removeUid(session, "Drafts", validity, uid);
  expect(await resolve(session, { folder: "Drafts", uid: 0, validity: null, messageId: id })).toBeNull();
  await session.logout();
});

test("closing the stream cancels a pending fetch", async () => {
  const session = await server.login();
  await session.appendWithFlags("INBOX", bytes(seeds[2]?.[0] ?? ""), []);
  await session.examine("INBOX");
  const pending = session.uidFetch("1:*", "(UID BODY.PEEK[])");
  session.stream.close();
  await expect(pending).rejects.toThrow("Connection Lost");
});

test("connections propagate connect failures and refuse stale body selections", async () => {
  await expect(new Connections().execute({ ...account, ssl: false }, (mail) => mail.folders())).rejects.toThrow("This account needs SSL or STARTTLS enabled in Online Accounts");
  const queue = new BodyQueue();
  queue.select(2);
  await expect(new Connections().executeBody(account, queue, 1, (mail) => mail.folders())).rejects.toThrow("Message selection changed");
});
