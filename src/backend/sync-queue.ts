import type { Account } from "../models";
import type { Status } from "../models/sync";
import { BodyQueue } from "./body-queue";
import { Signal } from "./signal";
import { isInbox, Tracker, type Inventory } from "./sync-progress";

export const WORKERS = 4;
const PER_ACCOUNT = 2;

export type Task =
  | { kind: "Discover" }
  | { kind: "Scan" }
  | { kind: "Headers"; validity: number; uids: number[]; offset: number }
  | { kind: "Body"; validity: number; uid: number; preview: boolean; timestamp: number }
  | { kind: "Bodies"; validity: number; before: [timestamp: number, uid: number] };

export interface Job {
  account: Account;
  folder: string;
  task: Task;
}

function key({ account, folder, task }: Job) {
  const item =
    task.kind === "Headers"
      ? [task.validity, task.offset]
      : task.kind === "Body"
        ? [task.validity, task.uid]
        : task.kind === "Bodies"
          ? [task.validity, task.before[1]]
          : [];
  return JSON.stringify([account.email, folder, task.kind, ...item]);
}

type Rank = [tier: number, phase: number, recency: number];

const DESCRIPTIONS = {
  Discover: "Syncing folders",
  Scan: "Syncing message lists",
  Headers: "Syncing message lists",
  Body: "Syncing messages",
  Bodies: "Syncing messages",
};

export class SyncQueue {
  readonly cancellation = new BodyQueue();
  #accounts = new Map<string, Account>();
  #removedAccounts = new Set<string>();
  #expanded = new Set<string>();
  #folders = new Map<string, string[]>();
  #sent = new Map<string, string>();
  #drafts = new Map<string, string>();
  #jobs: Job[] = [];
  #known = new Map<string, Job>();
  #running = new Map<string, Job>();
  #closed = false;
  #visible: string | null = null;
  #failed = 0;
  #lastStarted: number | null = null;
  #progress = new Tracker();
  #signal = new Signal();
  #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  status(): Status {
    const job = this.#earliest(this.#running.values()) ?? this.#jobs[0] ?? null;
    return {
      activity: job && {
        description: job.task.kind === "Body" && job.task.preview ? "Syncing previews" : DESCRIPTIONS[job.task.kind],
        folder: job.folder,
        progress: this.#progress.overall(this.#accounts.keys()),
      },
      active: this.#running.size,
      queued: this.#jobs.length,
      failed: this.#failed,
      lastStarted: this.#lastStarted,
    };
  }

  restoreStarted(started: number | null) {
    this.#lastStarted = started;
    this.#changed();
  }

  needsStartTime() {
    return !this.#closed && this.#accounts.size > 0 && this.#known.size === 0;
  }

  restoreFolders(account: string, folders: string[]) {
    this.#folders.set(account, folders);
  }

  discovered(account: string, folders: string[], sent: string | null, drafts: string | null) {
    if (sent === null) this.#sent.delete(account);
    else this.#sent.set(account, sent);
    if (drafts === null) this.#drafts.delete(account);
    else this.#drafts.set(account, drafts);
    const chosen = this.#folders.get(account) ?? [];
    const selected = folders
      .filter((folder) => folder === sent || folder === drafts || chosen.some((item) => item === folder || (isInbox(item) && isInbox(folder))))
      .map((folder) => (isInbox(folder) ? "INBOX" : folder))
      .filter((folder, index, all) => folder !== all[index - 1]);
    this.#progress.discovered(account, selected);
    this.#changed();
    return selected;
  }

  headersOnly(account: string, folder: string) {
    return this.isOutgoing(account, folder) && !(this.#folders.get(account) ?? []).includes(folder);
  }

  isOutgoing(account: string, folder: string) {
    return this.#sent.get(account) === folder || this.#drafts.get(account) === folder;
  }

  inventory(account: string, folder: string, inventory: Inventory) {
    this.#progress.inventory(account, folder, inventory);
    this.#changed();
  }

  bodyCached(account: string, folder: string, validity: number, uid: number) {
    this.#progress.bodyCached(account, folder, validity, uid);
    this.#changed();
  }

  headersCached(account: string, folder: string, validity: number) {
    this.#progress.headersCached(account, folder, validity);
    this.#changed();
  }

  focus(account: string, folder: string) {
    this.#visible = JSON.stringify([account, folder]);
  }

  visible(account: string, folder: string) {
    return this.#visible === JSON.stringify([account, folder]);
  }

  register(account: Account, expanded: boolean) {
    this.expanded(account.email, expanded);
    this.#removedAccounts.delete(account.email);
    this.#accounts.set(account.email, account);
    this.#changed();
  }

  retainAccounts(accounts: Account[]) {
    const live = new Set(accounts.map((account) => account.email));
    for (const email of this.#accounts.keys()) if (!live.has(email)) this.#removedAccounts.add(email);
    for (const entries of [this.#accounts, this.#expanded, this.#folders, this.#sent, this.#drafts])
      for (const email of entries.keys()) if (!live.has(email)) entries.delete(email);
    this.#jobs = this.#jobs.filter((job) => live.has(job.account.email));
    for (const [id, job] of this.#known) if (!live.has(job.account.email) && !this.#running.has(id)) this.#known.delete(id);
    this.#notify();
  }

  expanded(email: string, expanded: boolean) {
    if (expanded) this.#expanded.add(email);
    else this.#expanded.delete(email);
    this.#notify();
  }

  refresh() {
    const accounts = [...this.#accounts.values()];
    for (const account of accounts)
      if ((this.#folders.get(account.email) ?? []).some(isInbox)) this.#enqueue({ account, folder: "INBOX", task: { kind: "Scan" } });
    for (const account of accounts) this.#enqueue({ account, folder: "", task: { kind: "Discover" } });
    this.#notify();
  }

  push(job: Job) {
    this.#enqueue(job);
    this.#notify();
  }

  next(): Job | null {
    const active = new Map<string, number>();
    for (const job of this.#running.values()) active.set(job.account.email, (active.get(job.account.email) ?? 0) + 1);
    const inboxPending = [...this.#jobs, ...this.#running.values()].some((job) => isInbox(job.folder));
    return this.#earliest(
      this.#jobs.filter(
        (job) =>
          (active.get(job.account.email) ?? 0) < PER_ACCOUNT &&
          (!inboxPending || isInbox(job.folder) || job.task.kind === "Discover" || job.task.kind === "Scan"),
      ),
    );
  }

  async pop(): Promise<Job | null> {
    while (!this.#closed) {
      const job = this.next();
      if (job) {
        this.#jobs.splice(this.#jobs.indexOf(job), 1);
        this.#running.set(key(job), job);
        this.#changed();
        return job;
      }
      await this.#signal.wait();
    }
    return null;
  }

  finish(job: Job, success: boolean) {
    this.#known.delete(key(job));
    this.#running.delete(key(job));
    this.#failed += Number(!success);
    this.#notify();
  }

  close() {
    this.#closed = true;
    this.#jobs = [];
    this.cancellation.close();
    this.#notify();
  }

  #enqueue(job: Job) {
    if (this.#closed || this.#removedAccounts.has(job.account.email)) return;
    const scanning = (known: Job) =>
      known.account.email === job.account.email && known.folder === job.folder && (known.task.kind === "Scan" || known.task.kind === "Headers");
    if (job.task.kind === "Scan" && [...this.#known.values()].some(scanning)) return;
    if (this.#known.size === 0) {
      this.#failed = 0;
      this.#progress = new Tracker();
    }
    const id = key(job);
    if (this.#known.has(id)) return;
    this.#known.set(id, job);
    this.#jobs.push(job);
  }

  #notify() {
    this.#signal.notify();
    this.#changed();
  }

  #priority({ account, folder, task }: Job): Rank {
    const [phase, timestamp] =
      task.kind === "Body"
        ? [task.preview ? 1 : 3, task.timestamp]
        : task.kind === "Bodies"
          ? [3, task.before[0]]
          : task.kind === "Headers" && task.offset > 0
            ? [2, 0]
            : [0, 0];
    const tier = isInbox(folder) || task.kind === "Discover" ? 0 : this.#expanded.has(account.email) ? 1 : 2;
    return [tier, phase, -timestamp];
  }

  #earliest(jobs: Iterable<Job>) {
    let best: { job: Job; rank: Rank } | null = null;
    for (const job of jobs) {
      const rank = this.#priority(job);
      if (!best || (rank[0] - best.rank[0] || rank[1] - best.rank[1] || rank[2] - best.rank[2]) < 0) best = { job, rank };
    }
    return best && best.job;
  }
}
