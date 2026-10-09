import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../models";
import { message } from "../models";
import { Storage } from "./storage";
import { SyncQueue, type Job } from "./sync-queue";
import { enqueueBodies } from "./sync-worker";

const BODY_BATCH = 128;
const account: Account = { path: "a", email: "a", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };

async function pop(queue: SyncQueue) {
  const next = await queue.pop();
  if (!next) throw new Error("Queue closed");
  return next;
}

test("large mailboxes fill a bounded queue and resume after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-sync-"));
  const path = join(directory, "cache.db");
  const job: Job = { account, folder: "INBOX", task: { kind: "Scan" } };
  const uids = Array.from({ length: 300 }, (_, index) => index + 1);
  const flags = uids.map((uid) => ({ uid, read: false, flagged: false, draft: false }));
  const messages = uids.map((uid) => message({ uid, timestamp: uid }));
  let storage = Storage.open(path);
  storage.inventory("a", "INBOX", 1, flags);
  storage.storeHeaders("a", "INBOX", 1, messages);
  let queue = new SyncQueue(() => {});
  enqueueBodies(storage, queue, job, 1, null);
  expect(queue.status().queued).toBe(BODY_BATCH + 1);
  const first = await pop(queue);
  expect(first.task).toMatchObject({ kind: "Body", uid: 300, preview: true });
  storage.storeBody("a", "INBOX", 1, message({ uid: 300, timestamp: 300, bodyLoaded: true, bodyText: "Persisted" }));
  queue.finish(first, true);
  queue.close();
  storage.close();
  storage = Storage.open(path);
  expect(storage.inventory("a", "INBOX", 1, flags)).toEqual([]);
  expect(storage.message("a", "INBOX", 300)?.bodyText).toBe("Persisted");
  queue = new SyncQueue(() => {});
  enqueueBodies(storage, queue, job, 1, null);
  const seen = new Set<number>();
  while (queue.status().queued > 0) {
    expect(queue.status().queued).toBeLessThanOrEqual(BODY_BATCH + 1);
    const next = await pop(queue);
    if (next.task.kind === "Body") {
      expect(seen.has(next.task.uid)).toBeFalse();
      seen.add(next.task.uid);
    } else if (next.task.kind === "Bodies") enqueueBodies(storage, queue, next, next.task.validity, next.task.before);
    else throw new Error("Expected cached-body work");
    queue.finish(next, true);
  }
  expect(seen.size).toBe(299);
  expect(seen.has(300)).toBeFalse();
  queue.close();
  storage.close();
  rmSync(directory, { recursive: true });
});
