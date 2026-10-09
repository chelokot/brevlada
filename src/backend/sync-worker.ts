import { prepareDisplay } from "../models";
import { MESSAGE_LIMIT } from "../theme";
import { Connections } from "./connections";
import type { Mail } from "./mail";
import { cachedBody, headerBatch, inventory, syncFolders } from "./mail-sync";
import { failure, type Emit } from "./protocol";
import type { Storage } from "./storage";
import { isInbox } from "./sync-progress";
import { WORKERS, type Job, type SyncQueue } from "./sync-queue";

const HEADER_BATCH = 50;
const BODY_BATCH = 128;

export function start(storage: Storage, queue: SyncQueue, emit: Emit) {
  for (let slot = 0; slot < WORKERS; slot++) void run(storage, queue, emit);
}

async function run(storage: Storage, queue: SyncQueue, emit: Emit) {
  const connections = new Connections();
  for (let job = await queue.pop(); job; job = await queue.pop()) {
    const { account, folder } = job;
    const success = await execute(storage, queue, emit, connections, job).then(
      () => true,
      (error) => {
        if (queue.cancellation.current(0)) console.error(`Background mail sync failed for ${account.email} / ${folder}: ${failure(error)}`);
        return false;
      },
    );
    queue.finish(job, success);
  }
}

async function execute(storage: Storage, queue: SyncQueue, emit: Emit, connections: Connections, job: Job) {
  const { account, folder, task } = job;
  const email = account.email;
  const network = <T>(operation: (mail: Mail) => Promise<T>) => connections.executeBody(account, queue.cancellation, 0, operation);
  switch (task.kind) {
    case "Discover": {
      const discovered = await network(syncFolders);
      storage.storeFolders(email, discovered.all);
      const folders = queue.discovered(email, discovered.sync, discovered.sent, discovered.drafts);
      emit({ type: "Folders", account: email, folders: discovered.all });
      for (const name of folders) if (!isInbox(name)) queue.push({ account, folder: name, task: { kind: "Scan" } });
      return;
    }
    case "Scan": {
      const revision = storage.readRevision();
      const [validity, flags] = await network((mail) => inventory(mail, folder));
      const missing = storage.inventorySince(email, folder, validity, flags, revision);
      const needed = [...storage.uncachedUids(email, folder), ...missing];
      queue.inventory(email, folder, { validity, live: flags.map((flag) => flag.uid), needed, headersCached: missing.length === 0 });
      emit({ type: "Unread", account: email, folders: [[folder, flags.some((flag) => !flag.read)]] });
      publishList(storage, queue, emit, job);
      if (queue.isOutgoing(email, folder)) emit({ type: "SentCacheChanged", account: email });
      if (missing.length) queue.push({ ...job, task: { kind: "Headers", validity, uids: missing, offset: 0 } });
      else {
        publishNotifications(storage, emit, job, validity);
        if (!queue.headersOnly(email, folder)) enqueueBodies(storage, queue, job, validity, null);
      }
      return;
    }
    case "Headers": {
      const { validity, uids, offset } = task;
      const end = Math.min(offset + HEADER_BATCH, uids.length);
      const messages = await network((mail) => headerBatch(mail, folder, validity, uids.slice(offset, end)));
      storage.storeHeaders(email, folder, validity, messages);
      publishNotifications(storage, emit, job, validity);
      if (end === uids.length) {
        queue.headersCached(email, folder, validity);
        if (queue.isOutgoing(email, folder)) emit({ type: "SentCacheChanged", account: email });
      }
      if (offset === 0 || end === uids.length) {
        publishList(storage, queue, emit, job);
        if (!queue.headersOnly(email, folder)) enqueueBodies(storage, queue, job, validity, null);
      }
      if (end < uids.length) queue.push({ ...job, task: { ...task, offset: end } });
      return;
    }
    case "Bodies":
      if (storage.validity(email, folder) === task.validity) enqueueBodies(storage, queue, job, task.validity, task.before);
      return;
    case "Body": {
      const { validity, uid } = task;
      if (storage.validity(email, folder) !== validity) return;
      const cached = storage.message(email, folder, uid);
      if (!cached) return;
      if (cached.bodyLoaded) {
        queue.bodyCached(email, folder, validity, uid);
        return;
      }
      const fetched = await network((mail) => cachedBody(mail, folder, validity, uid));
      const message = storage.storeBody(email, folder, validity, fetched);
      if (!message) return;
      queue.bodyCached(email, folder, validity, uid);
      if (queue.visible(email, folder) || message.calendarEvents.length || message.tickets.length) {
        prepareDisplay(message);
        emit({ type: "CacheBody", account: email, folder, message });
      }
    }
  }
}

function publishNotifications(storage: Storage, emit: Emit, { account, folder }: Job, validity: number) {
  const messages = storage.pendingNotifications(account.email, folder, validity);
  if (messages.length) emit({ type: "NewMail", account: account.email, folder, validity, messages });
}

function publishList(storage: Storage, queue: SyncQueue, emit: Emit, { account, folder }: Job) {
  if (queue.visible(account.email, folder)) emit({ type: "CacheList", account: account.email, folder, messages: storage.senderHeaders(account.email, folder) });
}

export function enqueueBodies(storage: Storage, queue: SyncQueue, job: Job, validity: number, before: [timestamp: number, uid: number] | null) {
  const messages = storage.pendingBodies(job.account.email, job.folder, before, BODY_BATCH);
  messages.forEach(({ uid, timestamp }, index) =>
    queue.push({ ...job, task: { kind: "Body", validity, uid, preview: before === null && index < MESSAGE_LIMIT, timestamp } }),
  );
  const last = messages.at(-1);
  if (messages.length === BODY_BATCH && last) queue.push({ ...job, task: { kind: "Bodies", validity, before: [last.timestamp, last.uid] } });
}
