import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matches, message } from "../models";
import { event } from "../models/calendar";
import { groups } from "../models/senders";
import type { Reservation } from "../models/ticket";
import { isFresh, now, SOURCES } from "./avatar-cache";
import { Storage } from "./storage";

const RUST_SCHEMA = `
CREATE TABLE rust_messages (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id, folder, uid));
CREATE TABLE rust_removed_messages (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL, uid INTEGER NOT NULL,
  PRIMARY KEY(account_id, folder, uid_validity, uid));
CREATE TABLE rust_folders (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER, PRIMARY KEY(account_id, folder));
CREATE TABLE rust_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rust_notification_folders (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL, last_uid INTEGER NOT NULL,
  PRIMARY KEY(account_id,folder));
CREATE TABLE rust_notification_pending (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL, uid INTEGER NOT NULL,
  PRIMARY KEY(account_id,folder,uid_validity,uid));
CREATE TABLE rust_read_changes (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, uid_validity INTEGER, revision INTEGER NOT NULL,
  PRIMARY KEY(account_id, folder, uid));
CREATE TABLE rust_sync_settings (account_id TEXT PRIMARY KEY, folders TEXT NOT NULL);
CREATE TABLE rust_avatars (email TEXT PRIMARY KEY, source TEXT NOT NULL, image BLOB, fetched_at INTEGER NOT NULL);
CREATE TABLE rust_unread (account_id TEXT NOT NULL, folder TEXT NOT NULL, unread BOOLEAN NOT NULL, PRIMARY KEY(account_id, folder));
CREATE TABLE rust_sent_local (account_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id, message_id));`;

const RUST_MESSAGE = {
  uid: 1,
  message_id: "incoming",
  subject: "",
  sender: "",
  recipients: "",
  date: "",
  timestamp: 0,
  references: [],
  is_read: false,
  body_text: "Cached",
  body_html: "",
  attachments: [],
  body_loaded: true,
};

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-storage-"));
  return { path: join(directory, "cache.db"), remove: () => rmSync(directory, { recursive: true }) };
}

function rustCache(path: string, sql: string) {
  const database = new Database(path);
  database.run(RUST_SCHEMA);
  database.run(sql);
  database.close();
}

const reservation = (fields: Partial<Reservation>): Reservation => ({
  kind: "Event",
  number: null,
  status: null,
  name: "",
  start: null,
  end: null,
  departure: null,
  arrival: null,
  location: null,
  provider: null,
  service: null,
  url: null,
  holder: null,
  tickets: [],
  ...fields,
});

test("sender headers include older unread mail without loading heavy bodies", () => {
  const storage = Storage.open(":memory:");
  for (let uid = 1; uid <= 120; uid++) {
    const sender = uid === 1 || uid === 120 ? "Alice <alice@example.com>" : `sender${uid}@example.com`;
    const fields = { uid, timestamp: uid, sender, isRead: uid !== 1 && uid !== 2, bodyLoaded: true, bodyText: "Searchable cached text" };
    storage.store("a", "INBOX", message({ ...fields, bodyHtml: "<p>Cached body</p>", attachments: ["file.pdf"] }));
  }
  storage.store("b", "INBOX", message({ uid: 121 }));
  storage.store("a", "Archive", message({ uid: 122 }));
  const headers = storage.senderHeaders("a", "INBOX");
  expect(headers).toHaveLength(120);
  expect(headers.every((header) => !header.bodyLoaded && !header.bodyHtml && header.attachments.length === 0)).toBe(true);
  expect(headers.every((header) => matches(header, "searchable"))).toBe(true);
  const [first, second, ...rest] = groups(headers, "");
  expect(rest).toHaveLength(117);
  expect(first?.[0]?.uid).toBe(120);
  expect(first?.some((header) => !header.isRead)).toBe(true);
  expect(second?.[0]?.uid).toBe(2);
  const body = storage.message("a", "INBOX", 120);
  expect(body?.bodyLoaded).toBe(true);
  expect(body?.bodyHtml).toBe("<p>Cached body</p>");
  expect(body?.attachments).toEqual(["file.pdf"]);
});

test("sender pages are bounded and continue from the last message", () => {
  const storage = Storage.open(":memory:");
  for (let uid = 1; uid <= 120; uid++) {
    storage.store("a", "INBOX", message({ uid, timestamp: uid, sender: uid % 2 === 0 ? "Alice <ALICE@example.com>" : "Bob <bob@example.com>" }));
  }
  const first = storage.senderPage("a", "INBOX", "alice@example.com", null, 25);
  expect([first.length, first[0]?.uid, first[24]?.uid]).toEqual([25, 120, 72]);
  const next = storage.senderPage("a", "INBOX", "alice@example.com", [72, 72], 25);
  expect([next.length, next[0]?.uid, next[24]?.uid]).toEqual([25, 70, 22]);
});

test("sender page skips addresses only mentioned in display names", () => {
  const storage = Storage.open(":memory:");
  for (let uid = 1; uid <= 60; uid++) {
    storage.store("a", "INBOX", message({ uid, timestamp: uid, sender: uid > 30 ? "alice@example.com <other@example.com>" : "Alice <alice@example.com>" }));
  }
  const page = storage.senderPage("a", "INBOX", "alice@example.com", null, 10);
  expect([page.length, page[0]?.uid, page[9]?.uid]).toEqual([10, 30, 21]);
});

test("restores unread state with cached messages as a fallback", () => {
  const cache = temporary();
  const storage = Storage.open(cache.path);
  storage.store("a", "INBOX", message({ uid: 1 }));
  expect(storage.unread("a")).toEqual([["INBOX", true]]);
  storage.storeUnread("a", "INBOX", false);
  storage.storeUnread("a", "Archive", true);
  storage.storeUnread("b", "INBOX", true);
  storage.close();
  const reopened = Storage.open(cache.path);
  expect(reopened.unread("a").sort()).toEqual([
    ["Archive", true],
    ["INBOX", false],
  ]);
  reopened.close();
  cache.remove();
});

test("imports the Rust cache once without changing the original rows", () => {
  const cache = temporary();
  const { recurrenceId, organizerEmail, ...rustEvent } = event({ uid: "meeting" });
  const invitation = {
    ...RUST_MESSAGE,
    uid: 7,
    uid_validity: 3,
    message_id: "invitation",
    sender: "Host <host@example.com>",
    reply_to: "",
    cc: "",
    is_draft: false,
    is_flagged: true,
    read_revision: 4,
    flag_revision: 4,
    attachment_details: [{ mime: "text/calendar", size: 10, calendar_rendered: true }],
    inline_media: [{ content_id: "logo", mime: "image/png", data: "x" }],
    inline_media_loaded: true,
    unsubscribe: { url: "https://example.org/u", one_click: true },
    parcels: [
      {
        item: "Book",
        arrival_from: "a",
        arrival_until: "b",
        carrier: null,
        tracking_url: "https://track",
        order_url: null,
        order_number: "42",
        steps: [],
        details: { deliveryStatus: "In transit" },
      },
    ],
    calendar_events: [{ ...rustEvent, recurrence_id: "r", organizer_email: "host@example.com" }],
    tickets: [reservation({ name: "Concert" })],
  };
  const sent = { ...RUST_MESSAGE, uid: 0, message_id: "outgoing", sender: "me@example.com", reply_to: "", cc: "", references: ["invitation"] };
  rustCache(
    cache.path,
    `INSERT INTO rust_messages VALUES ('me@example.com', 'INBOX', 7, '${JSON.stringify(invitation)}');
     INSERT INTO rust_sent_local VALUES ('me@example.com', 'outgoing', '${JSON.stringify(sent)}');
     INSERT INTO rust_folders VALUES ('me@example.com', 'INBOX', 3), ('me@example.com', 'Archive', NULL);
     INSERT INTO rust_metadata VALUES ('read_revision', '9'), ('avatar_sources', '${SOURCES}'), ('last_sync_started', '1800000000');
     INSERT INTO rust_avatars VALUES ('host@example.com', 'google', x'01', 5);
     INSERT INTO rust_unread VALUES ('me@example.com', 'INBOX', 1);
     INSERT INTO rust_sync_settings VALUES ('me@example.com', '["INBOX","Archive"]');
     INSERT INTO rust_removed_messages VALUES ('me@example.com', 'INBOX', 3, 5);
     INSERT INTO rust_read_changes VALUES ('me@example.com', 'INBOX', 7, 3, 9);
     INSERT INTO rust_notification_folders VALUES ('me@example.com', 'INBOX', 3, 7);
     INSERT INTO rust_notification_pending VALUES ('me@example.com', 'INBOX', 3, 7);`,
  );
  const storage = Storage.open(cache.path);
  const imported = storage.message("me@example.com", "INBOX", 7);
  expect(imported).toEqual(
    message({
      uid: 7,
      uidValidity: 3,
      messageId: "invitation",
      sender: "Host <host@example.com>",
      bodyText: "Cached",
      bodyLoaded: true,
      isFlagged: true,
      readRevision: 4,
      flagRevision: 4,
      attachmentDetails: [{ mime: "text/calendar", size: 10, calendarRendered: true }],
      inlineMedia: [{ contentId: "logo", mime: "image/png", data: "x" }],
      inlineMediaLoaded: true,
      unsubscribe: { url: "https://example.org/u", oneClick: true },
      parcels: [
        {
          item: "Book",
          arrivalFrom: "a",
          arrivalUntil: "b",
          carrier: null,
          trackingUrl: "https://track",
          orderUrl: null,
          orderNumber: "42",
          steps: [],
          details: { deliveryStatus: "In transit" },
        },
      ],
      calendarEvents: [event({ uid: "meeting", organizerEmail: "host@example.com", recurrenceId: "r" })],
      tickets: [reservation({ name: "Concert" })],
    }),
  );
  expect(storage.calendarMessages("me@example.com", "meeting").map(({ uid }) => uid)).toEqual([7]);
  expect(storage.relatedSent("me@example.com", "Archive", [message({ messageId: "invitation" })]).map(({ message }) => message.messageId)).toEqual(["outgoing"]);
  expect(storage.folders("me@example.com")).toEqual(["Archive", "INBOX"]);
  expect([storage.validity("me@example.com", "INBOX"), storage.validity("me@example.com", "Archive")]).toEqual([3, null]);
  expect([storage.readRevision(), storage.lastSyncStarted()]).toEqual([9, 1800000000]);
  expect(storage.avatar("host@example.com")).toEqual({ image: new Uint8Array([1]), fetchedAt: 5 });
  expect(storage.unread("me@example.com")).toEqual([["INBOX", true]]);
  expect(storage.syncFolders("me@example.com")).toEqual(["INBOX", "Archive"]);
  expect(storage.pendingNotifications("me@example.com", "INBOX", 3).map(({ uid }) => uid)).toEqual([7]);
  expect(storage.notificationFolders()).toEqual([["me@example.com", "INBOX", 3]]);
  storage.reconcile("me@example.com", "INBOX", 3, [message({ uid: 5 }), message({ uid: 7, messageId: "invitation" })], [5, 7]);
  expect(storage.messages("me@example.com", "INBOX").map(({ uid, isRead }) => [uid, isRead])).toEqual([[7, false]]);
  storage.close();
  const raw = new Database(cache.path);
  raw.run("DELETE FROM headers");
  raw.close();
  const reopened = Storage.open(cache.path);
  expect(reopened.messages("me@example.com", "INBOX")).toEqual([]);
  reopened.close();
  const original = new Database(cache.path);
  expect(original.query("SELECT (SELECT count(*) FROM rust_messages) + (SELECT count(*) FROM rust_sent_local) AS count").get()).toEqual({ count: 2 });
  original.close();
  cache.remove();
});

test("isolates uids by account and folder", () => {
  const storage = Storage.open(":memory:");
  const original = message({ uid: 1, subject: "Original" });
  const other = { ...original, subject: "Other" };
  storage.store("a", "INBOX", original);
  storage.store("b", "INBOX", other);
  storage.store("a", "Sent", other);
  expect(storage.messages("a", "INBOX")[0]?.subject).toBe("Original");
  expect(storage.messages("b", "INBOX")[0]?.subject).toBe("Other");
});

test("finds a locally sent reply in a received thread", () => {
  const storage = Storage.open(":memory:");
  const received = message({ uid: 7, messageId: "incoming", sender: "other@example.com" });
  const sent = message({ messageId: "outgoing", sender: "Me <me@example.com>", references: ["incoming"], bodyText: "Hello", bodyLoaded: true });
  storage.storeSent("me@example.com", sent);
  expect(storage.relatedSent("me@example.com", "INBOX", [received])).toEqual([{ folder: "", message: sent }]);
});

test("caches one saved draft without removing other drafts and rejects a stale validity", () => {
  const storage = Storage.open(":memory:");
  const existing = message({ uid: 1, uidValidity: 7, messageId: "existing", isDraft: true, bodyLoaded: true, bodyText: "Keep this draft" });
  storage.storeSavedDraft("a", "Drafts", existing);
  const saved = { ...existing, uid: 2, messageId: "saved", bodyText: "New draft", cc: "cc@example.com" };
  storage.storeSavedDraft("a", "Drafts", saved);
  expect(storage.message("a", "Drafts", 1)).toEqual(existing);
  expect(storage.message("a", "Drafts", 2)).toEqual(saved);
  expect(() => storage.storeSavedDraft("a", "Drafts", { ...saved, uidValidity: 8 })).toThrow("Draft mailbox changed while caching");
  expect(() => storage.storeSavedDraft("a", "Drafts", { ...saved, uidValidity: null })).toThrow("Saved draft needs UIDVALIDITY");
  expect(() => storage.storeSavedDraft("a", "Drafts", { ...saved, bodyLoaded: false })).toThrow("Saved draft is incomplete");
  expect(storage.validity("a", "Drafts")).toBe(7);
  expect(storage.message("a", "Drafts", 1)).toEqual(existing);
});

test("injects related drafts without From or Message-ID and removes deleted drafts", () => {
  const storage = Storage.open(":memory:");
  const received = message({ uid: 7, messageId: "incoming", subject: "Topic", sender: "other@example.com" });
  const draft = message({ uid: 1, isDraft: true, recipients: "other@example.com", subject: "Re: Topic" });
  storage.store("me@example.com", "Drafts", draft);
  storage.store("else@example.com", "Drafts", draft);
  storage.store("me@example.com", "Drafts", { ...draft, uid: 2, messageId: "unrelated", subject: "Other topic" });
  const related = storage.relatedSent("me@example.com", "INBOX", [received]);
  expect(related).toHaveLength(1);
  expect(related[0]?.folder).toBe("Drafts");
  expect(related[0]?.message.isDraft).toBe(true);
  expect(related[0]?.message.messageId).toBe("brevlada-draft:Drafts:1");
  expect(storage.relatedSent("me@example.com", "Drafts", [received])).toEqual([]);
  storage.reconcile("me@example.com", "Drafts", 1, [], []);
  expect(storage.relatedSent("me@example.com", "INBOX", [received])).toEqual([]);
});

test("reconciles deletions, preserves bodies and resets on a new UIDVALIDITY", () => {
  const storage = Storage.open(":memory:");
  const header = message({ uid: 1 });
  storage.reconcile("a", "INBOX", 1, [header], [1]);
  const body = { ...header, bodyLoaded: true, bodyText: "Cached", tickets: [reservation({ number: "booking-one", name: "Concert" })] };
  storage.store("a", "INBOX", body);
  storage.reconcile("a", "INBOX", 1, [header], [1]);
  expect(storage.messages("a", "INBOX")[0]?.bodyLoaded).toBe(true);
  expect(storage.messages("a", "INBOX")[0]?.tickets).toEqual(body.tickets);
  storage.reconcile("a", "INBOX", 2, [header], [1]);
  expect(storage.messages("a", "INBOX")[0]?.bodyLoaded).toBe(false);
  expect(storage.messages("a", "INBOX")[0]?.tickets).toEqual([]);
  storage.reconcile("a", "INBOX", 2, [], []);
  expect(storage.messages("a", "INBOX")).toEqual([]);
});

test("reloads old cached headers and persists Reply-To from the fetched body", () => {
  const cache = temporary();
  rustCache(cache.path, `INSERT INTO rust_messages VALUES ('a', 'INBOX', 1, '${JSON.stringify(RUST_MESSAGE)}')`);
  const storage = Storage.open(cache.path);
  const cached = storage.message("a", "INBOX", 1);
  expect(cached?.bodyLoaded).toBe(false);
  expect(cached?.bodyText).toBe("Cached");
  const fetched = message({ uid: 1, messageId: "incoming", bodyLoaded: true, bodyText: "Cached", replyTo: "support@example.com", cc: "copy@example.com" });
  const refreshed = storage.storeBody("a", "INBOX", null, fetched);
  expect(refreshed?.bodyLoaded).toBe(true);
  expect(refreshed?.replyTo).toBe("support@example.com");
  expect(refreshed?.cc).toBe("copy@example.com");
  expect(storage.message("a", "INBOX", 1)).toEqual(refreshed);
  storage.close();
  cache.remove();
});

test("restores the sync start time even without a completed sync", () => {
  const cache = temporary();
  const storage = Storage.open(cache.path);
  expect(storage.lastSyncStarted()).toBeNull();
  storage.recordSyncStarted(1_800_000_000);
  storage.close();
  const reopened = Storage.open(cache.path);
  expect(reopened.lastSyncStarted()).toBe(1_800_000_000);
  reopened.close();
  cache.remove();
});

test("defaults existing and new accounts to INBOX and preserves saved selections", () => {
  const cache = temporary();
  const storage = Storage.open(cache.path);
  storage.storeFolders("existing", ["INBOX", "Archive"]);
  expect(storage.syncFolders("existing")).toEqual(["INBOX"]);
  expect(storage.syncFolders("new")).toEqual(["INBOX"]);
  const raw = new Database(cache.path);
  raw.run(`UPDATE syncSettings SET folders='["INBOX","Archive"]' WHERE account='existing'`);
  raw.run("UPDATE syncSettings SET folders='[]' WHERE account='new'");
  raw.close();
  storage.close();
  const reopened = Storage.open(cache.path);
  expect(reopened.syncFolders("existing")).toEqual(["INBOX", "Archive"]);
  expect(reopened.syncFolders("new")).toEqual([]);
  expect(reopened.syncFolders("another")).toEqual(["INBOX"]);
  expect(reopened.folders("existing")).toEqual(["Archive", "INBOX"]);
  reopened.close();
  cache.remove();
});

test("remembers downloaded avatars and misses separately and drops avatars from older sources", () => {
  const cache = temporary();
  const storage = Storage.open(cache.path);
  expect(storage.avatar("ada@example.com")).toBeNull();
  storage.storeAvatar("ada@example.com", "google", new TextEncoder().encode("image"));
  const cached = storage.avatar("ada@example.com");
  expect(cached?.image).toEqual(new TextEncoder().encode("image"));
  expect(isFresh(true, cached?.fetchedAt ?? 0, now())).toBe(true);
  storage.storeAvatar("ada@example.com", "none", null);
  expect(storage.avatar("ada@example.com")?.image).toBeNull();
  storage.close();
  const raw = new Database(cache.path);
  expect(raw.query("SELECT source FROM avatars").all()).toEqual([{ source: "none" }]);
  raw.run("UPDATE metadata SET value='older' WHERE key='avatar_sources'");
  raw.close();
  const reopened = Storage.open(cache.path);
  expect(reopened.avatar("ada@example.com")).toBeNull();
  reopened.close();
  cache.remove();
});
