import { expect, test } from "bun:test";
import type { Account } from "../models";
import { SyncQueue, type Job, type Task } from "./sync-queue";

const account = (email: string): Account => ({
  path: email,
  email,
  name: "",
  host: "",
  username: "",
  port: 993,
  ssl: true,
  tls: false,
  oauth2: false,
  smtp: null,
});
const job = (email: string, folder: string, task: Task): Job => ({ account: account(email), folder, task });
const scan: Task = { kind: "Scan" };
const body = (uid: number, preview: boolean, timestamp: number): Task => ({ kind: "Body", validity: 1, uid, preview, timestamp });

async function pop(queue: SyncQueue) {
  const next = await queue.pop();
  if (!next) throw new Error("Queue closed");
  return next;
}

test("schedules selected folders and sent without changing selection", async () => {
  const queue = new SyncQueue(() => {});
  for (const [email, folders] of [
    ["default", ["INBOX"]],
    ["custom", ["Archive"]],
    ["empty", []],
  ] as const) {
    queue.restoreFolders(email, [...folders]);
    queue.register(account(email), false);
  }
  queue.refresh();
  const available = ["INBOX", "Archive", "Sent"];
  const scanned: string[] = [];
  while (queue.status().queued > 0) {
    const next = await pop(queue);
    if (next.task.kind === "Discover") {
      for (const folder of queue.discovered(next.account.email, available, "Sent", null))
        if (folder !== "INBOX") queue.push(job(next.account.email, folder, scan));
    } else if (next.task.kind === "Scan") scanned.push(`${next.account.email}/${next.folder}`);
    else throw new Error("Unexpected work");
    queue.finish(next, true);
  }
  expect(scanned.sort()).toEqual(["custom/Archive", "custom/Sent", "default/INBOX", "default/Sent", "empty/Sent"]);
  queue.close();
});

test("implicit sent sync fetches headers only", () => {
  const queue = new SyncQueue(() => {});
  queue.restoreFolders("account", ["INBOX"]);
  queue.discovered("account", ["INBOX", "Sent"], "Sent", null);
  expect(queue.headersOnly("account", "Sent")).toBeTrue();
  expect(queue.headersOnly("account", "INBOX")).toBeFalse();
  queue.restoreFolders("account", ["INBOX", "Sent"]);
  expect(queue.headersOnly("account", "Sent")).toBeFalse();
});

test("syncs drafts implicitly without changing selected folders", () => {
  const queue = new SyncQueue(() => {});
  queue.restoreFolders("account", ["INBOX"]);
  const available = ["INBOX", "Sent", "Entwürfe"];
  expect(queue.discovered("account", available, "Sent", "Entwürfe")).toEqual(available);
  expect(queue.headersOnly("account", "Entwürfe")).toBeTrue();
  expect(queue.headersOnly("account", "Sent")).toBeTrue();
  expect(queue.isOutgoing("account", "Entwürfe")).toBeTrue();
  queue.restoreFolders("account", ["INBOX", "Entwürfe"]);
  expect(queue.headersOnly("account", "Entwürfe")).toBeFalse();
  queue.discovered("account", available, "Sent", null);
  expect(queue.isOutgoing("account", "Entwürfe")).toBeFalse();
});

test("status preserves sync start time after completion, failure or cancellation", async () => {
  let changes = 0;
  const queue = new SyncQueue(() => changes++);
  expect(queue.status().lastStarted).toBeNull();
  const started = 1_800_000_000;
  queue.restoreStarted(started);
  queue.push(job("a", "INBOX", scan));
  queue.push(job("b", "INBOX", scan));
  expect(queue.status().queued).toBe(2);
  const first = await pop(queue);
  const second = await pop(queue);
  expect(queue.status().active).toBe(2);
  queue.finish(first, true);
  expect(queue.status().activity).toEqual({
    description: "Syncing message lists",
    folder: "INBOX",
    progress: { accounts: null, folders: null, messages: null },
  });
  expect(queue.status().lastStarted).toBe(started);
  queue.finish(second, true);
  expect(queue.status().activity).toBeNull();
  queue.push(job("a", "INBOX", scan));
  queue.finish(await pop(queue), false);
  expect(queue.status().failed).toBe(1);
  expect(queue.status().lastStarted).toBe(started);
  queue.push(job("a", "INBOX", scan));
  expect(queue.status().failed).toBe(0);
  const cancelled = await pop(queue);
  queue.close();
  queue.finish(cancelled, true);
  expect(queue.status().lastStarted).toBe(started);
  expect(changes).toBeGreaterThan(10);
});

test("prioritizes inboxes, then expanded accounts, and orders work within each tier", async () => {
  const queue = new SyncQueue(() => {});
  queue.push(job("a", "Archive", scan));
  queue.push(job("b", "Work", scan));
  queue.push(job("a", "INBOX", body(1, false, 1)));
  queue.push(job("a", "INBOX", body(2, true, 2)));
  queue.push(job("c", "INBOX", scan));
  queue.expanded("b", true);
  const order: string[] = [];
  for (let index = 0; index < 5; index++) {
    const next = await pop(queue);
    order.push(`${next.account.email}/${next.folder}/${next.task.kind === "Body" ? next.task.uid : next.task.kind}`);
    queue.finish(next, true);
  }
  expect(order).toEqual(["c/INBOX/Scan", "a/INBOX/2", "a/INBOX/1", "b/Work/Scan", "a/Archive/Scan"]);
  const waiting = queue.pop();
  queue.close();
  expect(await waiting).toBeNull();
});

test("other folders wait for running inboxes across accounts", async () => {
  const queue = new SyncQueue(() => {});
  queue.push(job("a", "INBOX", body(1, false, 1)));
  queue.push(job("b", "Archive", body(2, true, 100)));
  const inboxA = await pop(queue);
  expect(inboxA.folder).toBe("INBOX");
  expect(queue.next()).toBeNull();
  queue.push(job("b", "Work", scan));
  const inventory = await pop(queue);
  expect(inventory.task.kind).toBe("Scan");
  queue.finish(inventory, true);
  queue.push(job("b", "INBOX", scan));
  const inboxB = await pop(queue);
  expect(inboxB.folder).toBe("INBOX");
  queue.push(job("b", "INBOX", body(3, true, 2)));
  queue.finish(inboxB, true);
  const bodyB = await pop(queue);
  expect(bodyB.folder).toBe("INBOX");
  queue.finish(inboxA, true);
  expect(queue.next()).toBeNull();
  queue.finish(bodyB, true);
  const archive = await pop(queue);
  expect(archive.folder).toBe("Archive");
  queue.finish(archive, true);
  queue.close();
});

test("deduplicates active work and caps parallel requests per account", async () => {
  const queue = new SyncQueue(() => {});
  const first = job("a", "INBOX", scan);
  queue.push(first);
  queue.push(first);
  const active = await pop(queue);
  queue.push(first);
  queue.push(job("a", "Work", scan));
  queue.push(job("a", "Archive", scan));
  const second = await pop(queue);
  queue.push(job("b", "Archive", scan));
  const third = await pop(queue);
  expect(third.account.email).toBe("b");
  queue.finish(active, true);
  expect((await pop(queue)).folder).toBe("Archive");
  queue.finish(second, true);
  queue.finish(third, true);
  queue.close();
});

test("a blocked pop resumes once work becomes eligible", async () => {
  const queue = new SyncQueue(() => {});
  queue.push(job("a", "INBOX", scan));
  queue.push(job("a", "Work", scan));
  queue.push(job("a", "Archive", scan));
  const inbox = await pop(queue);
  const waiting = queue.pop();
  queue.finish(inbox, true);
  expect((await waiting)?.folder).toBe("Work");
  queue.close();
});
