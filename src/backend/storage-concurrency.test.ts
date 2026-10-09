import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../gi";
import { message } from "../models";
import { Storage } from "./storage";

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-concurrency-"));
  return { directory, path: join(directory, "cache.db"), remove: () => rmSync(directory, { recursive: true }) };
}

async function worker(directory: string, source: string, start: (url: URL) => Worker) {
  const script = join(directory, `worker-${crypto.randomUUID()}.ts`);
  await Bun.write(script, source);
  return start(new URL(`file://${script}`));
}

const next = (target: Worker) => new Promise<unknown>((resolve) => (target.onmessage = ({ data }) => resolve(data)));

test("opening an active cache does not request a SQLite write lock", () => {
  const cache = temporary();
  const storage = Storage.open(cache.path);
  const external = new Database(cache.path);
  external.run("BEGIN IMMEDIATE");
  const started = performance.now();
  const reopened = Storage.open(cache.path);
  const alias = Storage.open(join(cache.directory, ".", "cache.db"));
  const reader = Storage.openReadOnly(cache.path);
  expect(performance.now() - started).toBeLessThan(1000);
  expect([reopened.folders("a"), alias.folders("a"), reader.folders("a")]).toEqual([[], [], []]);
  external.run("ROLLBACK");
  external.close();
  reopened.storeUnread("a", "INBOX", true);
  expect(storage.unread("a")).toEqual([["INBOX", true]]);
  for (const item of [storage, reopened, alias, reader]) item.close();
  cache.remove();
});

test("competing writes wait while reads continue", async () => {
  const cache = temporary();
  const first = Storage.open(cache.path);
  const second = Storage.open(cache.path);
  const reader = Storage.openReadOnly(cache.path);
  first.storeUnread("a", "INBOX", false);
  const writer = await worker(
    cache.directory,
    `import { Database } from "bun:sqlite";
     self.onmessage = ({ data }) => {
       const database = new Database(data);
       database.run("BEGIN IMMEDIATE");
       database.run("UPDATE unread SET unread=1");
       postMessage("locked");
       Bun.sleepSync(300);
       database.run("COMMIT");
       database.close();
       postMessage("closed");
     };`,
    (url) => new Worker(url),
  );
  const locked = next(writer);
  writer.postMessage(cache.path);
  await locked;
  const closed = next(writer);
  const duringWrite = reader.unread("a");
  const started = performance.now();
  second.storeUnread("a", "Archive", true);
  expect(performance.now() - started).toBeGreaterThan(100);
  expect(duringWrite).toEqual([["INBOX", false]]);
  expect(reader.unread("a").sort()).toEqual([
    ["Archive", true],
    ["INBOX", true],
  ]);
  await closed;
  writer.terminate();
  for (const item of [first, second, reader]) item.close();
  cache.remove();
});

test("concurrent startup and mixed cache writes from several workers succeed", async () => {
  const cache = temporary();
  const source = `import { message } from ${JSON.stringify(Bun.fileURLToPath(new URL("../models/index.ts", import.meta.url)))};
    import { Storage } from ${JSON.stringify(Bun.fileURLToPath(new URL("./storage.ts", import.meta.url)))};
    self.onmessage = ({ data: [path, account] }) => {
      const storage = Storage.open(path);
      storage.storeFolders(account, ["INBOX"]);
      storage.syncFolders(account);
      for (let uid = 1; uid <= 5; uid++) {
        const cached = message({ uid, uidValidity: 7, messageId: account + "-" + uid, bodyLoaded: true, bodyText: "Cached body" });
        storage.inventory(account, "INBOX", 7, Array.from({ length: uid }, (_, index) => ({ uid: index + 1, read: false, flagged: false, draft: false })));
        storage.storeHeaders(account, "INBOX", 7, [cached]);
        storage.storeBody(account, "INBOX", 7, cached);
        storage.markReadCached(account, "INBOX", 7, uid);
        storage.storeSent(account, cached);
        storage.storeAvatar(cached.messageId, "none", null);
        storage.storeUnread(account, "INBOX", false);
        storage.recordSyncStarted(uid);
      }
      postMessage(storage.messages(account, "INBOX").length);
      storage.close();
    };
    postMessage("ready");`;
  const workers: Worker[] = [];
  for (let index = 0; index < 4; index++) {
    const target = await worker(cache.directory, source, spawn);
    await next(target);
    workers.push(target);
  }
  const counts = await Promise.all(
    workers.map((target, index) => {
      const done = new Promise((resolve, reject) => {
        target.onmessage = ({ data }) => resolve(data);
        target.onerror = reject;
      });
      target.postMessage([cache.path, `account-${index}`]);
      return done;
    }),
  );
  expect(counts).toEqual(Array(4).fill(5));
  for (const target of workers) target.terminate();
  cache.remove();
}, 30_000);

test("failed transactions release the write lock and memory caches are independent", () => {
  const cache = temporary();
  const first = Storage.open(cache.path);
  const second = Storage.open(cache.path);
  expect(() => first.storeHeaders("a", "INBOX", 7, [message({ uid: 1, uidValidity: 7 })])).toThrow("Mailbox changed during sync");
  second.storeUnread("a", "INBOX", true);
  expect(first.readRevision()).toBe(0);
  const memory = Storage.open(":memory:");
  const otherMemory = Storage.open(":memory:");
  memory.storeUnread("a", "INBOX", true);
  expect(otherMemory.unread("a")).toEqual([]);
  for (const item of [first, second, memory, otherMemory]) item.close();
  cache.remove();
});

test("a read-only connection initializes an old cache before reading it", () => {
  const cache = temporary();
  const database = new Database(cache.path);
  database.run(`CREATE TABLE rust_messages (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE rust_folders (account_id TEXT, folder TEXT, uid_validity INTEGER); CREATE TABLE rust_removed_messages (a, b, c, d);
    CREATE TABLE rust_metadata (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE rust_notification_folders (a, b, c, d);
    CREATE TABLE rust_notification_pending (a, b, c, d); CREATE TABLE rust_read_changes (a, b, c, d, e); CREATE TABLE rust_sync_settings (a, b);
    CREATE TABLE rust_avatars (a, b, c, d); CREATE TABLE rust_unread (a, b, c); CREATE TABLE rust_sent_local (account_id, message_id, data);
    INSERT INTO rust_messages VALUES ('a', 'INBOX', 1, '{"uid":1,"message_id":"one","subject":"Kept","sender":"","reply_to":"","recipients":"","cc":"",
      "date":"","timestamp":0,"references":[],"is_read":true,"body_text":"","body_html":"","attachments":[]}');`);
  database.close();
  const reader = Storage.openReadOnly(cache.path);
  expect(reader.searchFolders("a")).toEqual(["INBOX"]);
  expect(reader.senderHeaders("a", "INBOX").map(({ subject, isRead }) => [subject, isRead])).toEqual([["Kept", true]]);
  reader.close();
  cache.remove();
});
