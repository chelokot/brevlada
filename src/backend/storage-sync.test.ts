import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, type Message } from "../models";
import type { Reservation } from "../models/ticket";
import type { Flags } from "./mail-sync";
import { Storage } from "./storage";

const flags = (...items: [uid: number, read: boolean][]): Flags[] => items.map(([uid, read]) => ({ uid, read, flagged: false, draft: false }));
const cached = () => message({ uid: 1, uidValidity: 7, messageId: "one", bodyLoaded: true, bodyText: "Cached body" });
const train: Reservation = {
  kind: "Train",
  number: "booking-one",
  status: null,
  name: "Express",
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
};

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-storage-"));
  return { path: join(directory, "cache.db"), remove: () => rmSync(directory, { recursive: true }) };
}

test("refreshes legacy unsubscribe headers without overwriting the cached body or flags", () => {
  const storage = Storage.open(":memory:");
  const legacy = message({
    uid: 2,
    messageId: "same",
    bodyLoaded: true,
    bodyText: "Cached body",
    isRead: true,
    isFlagged: true,
    unsubscribe: { url: "https://example.org/u", oneClick: null },
  });
  storage.store("a", "INBOX", legacy);
  const header = { ...legacy, unsubscribe: { url: "https://example.org/u", oneClick: true }, bodyLoaded: false, bodyText: "", isRead: false, isFlagged: false };
  storage.storeUnsubscribe("a", "INBOX", null, header);
  expect(storage.message("a", "INBOX", 2)).toEqual({ ...legacy, unsubscribe: header.unsubscribe });
  expect(() => storage.storeUnsubscribe("a", "INBOX", 99, header)).toThrow("Mailbox changed while loading unsubscribe headers");
  expect(() => storage.storeUnsubscribe("a", "INBOX", null, { ...header, messageId: "replaced" })).toThrow("The mailbox changed. Reload the folder.");
  expect(() => storage.storeUnsubscribe("a", "INBOX", null, { ...header, uid: 3 })).toThrow("Message is no longer cached");
  expect(storage.message("a", "INBOX", 2)?.unsubscribe?.oneClick).toBe(true);
});

test("resumes missing work and rejects obsolete bodies", () => {
  const storage = Storage.open(":memory:");
  const inbox = flags([1, false], [2, false]);
  expect(storage.inventory("a", "INBOX", 7, inbox)).toEqual([2, 1]);
  const header = message({ uid: 2, messageId: "new" });
  storage.storeHeaders("a", "INBOX", 7, [header]);
  expect(storage.inventory("a", "INBOX", 7, inbox)).toEqual([1]);
  expect(storage.uncachedUids("a", "INBOX")).toEqual([2]);
  const fetched = { ...header, bodyLoaded: true, bodyText: "Cached body", tickets: [train] };
  storage.store("a", "INBOX", { ...header, isRead: true, isFlagged: true });
  const stored = storage.storeBody("a", "INBOX", 7, fetched);
  expect([stored?.isRead, stored?.isFlagged, stored?.bodyLoaded]).toEqual([true, true, true]);
  expect(stored?.tickets).toEqual([train]);
  const marked = storage.markReadCached("a", "INBOX", 7, 2);
  expect([marked?.isRead, marked?.isFlagged, marked?.bodyLoaded]).toEqual([true, true, true]);
  expect(storage.markReadCached("a", "INBOX", 8, 2)).toBeNull();
  expect(storage.pendingBodies("a", "INBOX", null, 128)).toEqual([]);
  expect(storage.uncachedUids("a", "INBOX")).toEqual([]);
  storage.inventory("a", "INBOX", 8, inbox);
  expect(storage.storeBody("a", "INBOX", 7, fetched)).toBeNull();
  storage.storeHeaders("a", "INBOX", 8, [header]);
  storage.inventory("a", "INBOX", 8, []);
  expect(storage.storeBody("a", "INBOX", 8, fetched)).toBeNull();
  expect(storage.messages("a", "INBOX")).toEqual([]);
});

test("pending bodies page newest first without body payloads", () => {
  const storage = Storage.open(":memory:");
  storage.inventory("a", "INBOX", 7, flags([1, false], [2, false], [3, false]));
  const headers = [1, 2, 3].map((uid) => message({ uid, timestamp: uid, messageId: `${uid}`, bodyText: "partial", calendarEvents: [], attachments: ["a.pdf"] }));
  storage.storeHeaders("a", "INBOX", 7, headers);
  const first = storage.pendingBodies("a", "INBOX", null, 2);
  expect(first.map(({ uid }) => uid)).toEqual([3, 2]);
  expect(first.every(({ bodyText, attachments }) => bodyText === "" && attachments.length === 0)).toBe(true);
  expect(storage.pendingBodies("a", "INBOX", [2, 2], 2).map(({ uid }) => uid)).toEqual([1]);
});

test("a concurrent folder refresh cannot undo a confirmed read", () => {
  const cache = temporary();
  const refresh = Storage.open(cache.path);
  const reader = Storage.open(cache.path);
  refresh.reconcile("a", "INBOX", 7, [cached()], [1]);
  const started = refresh.readRevision();
  const confirmed = reader.markReadCached("a", "INBOX", 7, 1);
  const stale: Flags[] = [{ uid: 1, read: false, flagged: true, draft: false }];
  refresh.inventorySince("a", "INBOX", 7, stale, started);
  let current = refresh.message("a", "INBOX", 1);
  expect([current?.isRead, current?.isFlagged, current?.bodyText]).toEqual([true, true, "Cached body"]);
  expect((current?.readRevision ?? 0) > (confirmed?.readRevision ?? 0)).toBe(true);
  expect(refresh.unread("a").some(([, unread]) => unread)).toBe(false);
  refresh.inventorySince("a", "INBOX", 7, stale, refresh.readRevision());
  current = refresh.message("a", "INBOX", 1);
  expect(current?.isRead).toBe(false);
  expect((current?.readRevision ?? 0) > (confirmed?.readRevision ?? 0)).toBe(true);
  refresh.inventorySince("a", "INBOX", 7, stale, started);
  expect(refresh.message("a", "INBOX", 1)?.isRead).toBe(false);
  reader.close();
  refresh.close();
  cache.remove();
});

test("stale headers keep a confirmed read and a newer body scoped to the mailbox", () => {
  const storage = Storage.open(":memory:");
  const mailboxes = [
    ["a", "INBOX"],
    ["b", "INBOX"],
    ["a", "Archive"],
  ] as const;
  for (const [account, folder] of mailboxes) storage.reconcile(account, folder, 7, [cached()], [1]);
  const started = storage.readRevision();
  storage.confirmAction("a", "INBOX", [cached()], { kind: "MarkRead" });
  const header = { ...cached(), bodyLoaded: false, bodyText: "" };
  for (const [account, folder] of mailboxes) {
    storage.reconcileSince(account, folder, 7, [header], [1], started);
    const stored = storage.message(account, folder, 1);
    expect(stored?.isRead).toBe(account === "a" && folder === "INBOX");
    expect(stored?.bodyText).toBe("Cached body");
  }
  storage.reconcileSince("a", "INBOX", 8, [header], [1], started);
  expect(storage.message("a", "INBOX", 1)?.isRead).toBe(false);
  expect(storage.markReadCached("a", "INBOX", 7, 1)).toBeNull();
});

test("unread and star changes survive stale inventory, headers and bodies", () => {
  const storage = Storage.open(":memory:");
  const original = { ...cached(), isRead: true };
  for (const folder of ["INBOX", "Archive"]) storage.reconcile("a", folder, 7, [original], [1]);
  const started = storage.readRevision();
  storage.confirmAction("a", "INBOX", [original], { kind: "MarkUnread" });
  storage.confirmAction("a", "INBOX", [original], { kind: "Star" });
  const inbox: Flags[] = [{ uid: 1, read: true, flagged: false, draft: false }];
  storage.inventorySince("a", "INBOX", 7, inbox, started);
  storage.reconcileSince("a", "INBOX", 7, [original], [1], started);
  const current = storage.storeBody("a", "INBOX", 7, original);
  expect([current?.isRead, current?.isFlagged, current?.bodyText]).toEqual([false, true, "Cached body"]);
  expect((current?.readRevision ?? 0) > started && (current?.flagRevision ?? 0) > started).toBe(true);
  const other = storage.message("a", "Archive", 1);
  expect([other?.isRead, other?.isFlagged]).toEqual([true, false]);
  expect(storage.unread("a")).toContainEqual(["INBOX", true]);
  const beforeUnstar = storage.readRevision();
  storage.confirmAction("a", "INBOX", [original], { kind: "Unstar" });
  const stale: Flags[] = [{ uid: 1, read: true, flagged: true, draft: false }];
  storage.inventorySince("a", "INBOX", 7, stale, beforeUnstar);
  expect(storage.message("a", "INBOX", 1)?.isFlagged).toBe(false);
  storage.inventory("a", "INBOX", 8, stale);
  expect(storage.message("a", "INBOX", 1)).toBeNull();
});

test("confirmed removals survive stale sync writes and UID reuse is scoped", () => {
  const storage = Storage.open(":memory:");
  const removed: Message = message({ uid: 1, uidValidity: 7, messageId: "one" });
  storage.reconcile("a", "INBOX", 7, [removed], [1]);
  storage.confirmAction("a", "INBOX", [removed], { kind: "Archive" });
  storage.storeHeaders("a", "INBOX", 7, [removed]);
  storage.reconcile("a", "INBOX", 7, [removed], [1]);
  expect(storage.inventory("a", "INBOX", 7, flags([1, false]))).toEqual([]);
  expect(storage.message("a", "INBOX", 1)).toBeNull();
  expect(storage.storeBody("a", "INBOX", 7, removed)).toBeNull();
  expect(() => storage.confirmAction("a", "INBOX", [{ ...removed, uidValidity: null }], { kind: "Delete" })).toThrow("Missing message UIDVALIDITY");
  storage.reconcile("b", "INBOX", 7, [removed], [1]);
  storage.reconcile("a", "Archive", 7, [removed], [1]);
  expect(storage.message("b", "INBOX", 1)).not.toBeNull();
  expect(storage.message("a", "Archive", 1)).not.toBeNull();
  storage.reconcile("a", "INBOX", 8, [removed], [1]);
  expect(storage.message("a", "INBOX", 1)?.uidValidity).toBe(8);
});

test("deletes unsaved drafts by Message-ID and saved drafts by UID", () => {
  const storage = Storage.open(":memory:");
  storage.reconcile("a", "Drafts", 7, [message({ uid: 1, messageId: "saved", isDraft: true }), message({ uid: 2, messageId: "local", isDraft: true })], [1, 2]);
  storage.deleteDraft("a", { folder: "Drafts", uid: 0, validity: null, messageId: "local" });
  storage.deleteDraft("a", { folder: "Drafts", uid: 1, validity: 7, messageId: "saved" });
  expect(storage.messages("a", "Drafts")).toEqual([]);
  storage.reconcile("a", "Drafts", 7, [message({ uid: 1, messageId: "saved", isDraft: true })], [1]);
  expect(storage.messages("a", "Drafts")).toEqual([]);
});

const headers = (storage: Storage, validity: number, uids: number[]) =>
  storage.storeHeaders(
    "account",
    "INBOX",
    validity,
    uids.map((uid) => message({ uid, uidValidity: validity, messageId: `message-${validity}-${uid}`, subject: `Subject ${uid}` })),
  );
const pending = (storage: Storage, validity: number) => storage.pendingNotifications("account", "INBOX", validity).map(({ uid }) => uid);

test("an incomplete historical cache does not notify but offline arrivals do", () => {
  const storage = Storage.open(":memory:");
  storage.inventory("account", "INBOX", 1, flags([1, false], [2, false]));
  headers(storage, 1, [1]);
  expect(pending(storage, 1)).toEqual([]);
  const current = flags([1, false], [2, false], [3, false], [4, true]);
  storage.inventory("account", "INBOX", 1, current);
  headers(storage, 1, [2, 3]);
  expect(pending(storage, 1)).toEqual([3]);
  storage.acknowledgeNotifications("account", "INBOX", 1, [3]);
  storage.inventory("account", "INBOX", 1, current);
  expect(pending(storage, 1)).toEqual([]);
});

test("upgrading uses the existing cache as a baseline", () => {
  const storage = Storage.open(":memory:");
  storage.reconcile("account", "INBOX", 1, [], []);
  headers(storage, 1, [10]);
  storage.inventory("account", "INBOX", 1, flags([9, false], [10, false], [11, false]));
  headers(storage, 1, [9, 11]);
  expect(pending(storage, 1)).toEqual([11]);
});

test("pending arrivals survive a restart and UID resets are silent", () => {
  const cache = temporary();
  let storage = Storage.open(cache.path);
  storage.inventory("account", "INBOX", 1, flags([1, false]));
  headers(storage, 1, [1]);
  storage.inventory("account", "INBOX", 1, flags([1, false], [2, false]));
  storage.close();
  storage = Storage.open(cache.path);
  storage.inventory("account", "INBOX", 1, flags([1, false], [2, false]));
  headers(storage, 1, [2]);
  expect(pending(storage, 1)).toEqual([2]);
  storage.inventory("account", "INBOX", 2, flags([1, false], [2, false]));
  headers(storage, 2, [1, 2]);
  expect(pending(storage, 2)).toEqual([]);
  expect(storage.notificationFolders()).toEqual([]);
  storage.close();
  cache.remove();
});

test("read and removed arrivals are discarded", () => {
  const storage = Storage.open(":memory:");
  storage.inventory("account", "INBOX", 1, []);
  storage.inventory("account", "INBOX", 1, flags([1, false], [2, false]));
  headers(storage, 1, [1, 2]);
  expect(storage.notificationFolders()).toEqual([["account", "INBOX", 1]]);
  storage.inventory("account", "INBOX", 1, flags([1, true]));
  expect(pending(storage, 1)).toEqual([]);
  expect(storage.notificationFolders()).toEqual([]);
});
