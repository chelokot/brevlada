import { prepareDisplay, type Message } from "../models";
import * as accounts from "./accounts";
import { AvatarQueue } from "./avatar-queue";
import * as avatarWorker from "./avatar-worker";
import { BodyQueue } from "./body-queue";
import * as bodyWorker from "./body-worker";
import * as calendar from "./calendar";
import { Connections } from "./connections";
import * as draftSave from "./draft-save";
import * as drafts from "./drafts";
import { ensureDraftId } from "./mail-sync";
import { history } from "./parcel-worker";
import { attempt, failure, type Command, type Emit, type Event } from "./protocol";
import * as senderActions from "./sender-actions";
import * as smtp from "./smtp";
import { Storage } from "./storage";
import { SyncQueue } from "./sync-queue";
import * as syncWorker from "./sync-worker";
import * as unsubscribe from "./unsubscribe";

declare const self: Worker;

const STATUS_DELAY = 100;

function serial() {
  let tail = Promise.resolve();
  return (task: () => Promise<void>) => void (tail = tail.then(task));
}

function prepared(message: Message) {
  prepareDisplay(message);
  return message;
}

function serve(path: string, emit: Emit) {
  let storage: Storage;
  try {
    storage = Storage.open(path);
  } catch (error) {
    emit({ type: "Error", generation: null, error: `Could not open email cache: ${failure(error)}` });
    process.exit();
  }
  let publishing = false;
  const background = new SyncQueue(() => {
    if (publishing) return;
    publishing = true;
    setTimeout(() => {
      publishing = false;
      emit({ type: "SyncStatus", status: background.status() });
    }, STATUS_DELAY);
  });
  const bodies = new BodyQueue();
  const avatars = new AvatarQueue();
  for (let slot = 0; slot < 2; slot++) void bodyWorker.start(storage, bodies, emit);
  for (let slot = 0; slot < 2; slot++) void avatarWorker.start(storage, avatars, emit);
  syncWorker.start(storage, background, emit);
  const connections = new Connections();
  const parcelConnections = new Connections();
  const parcels = serial();
  const network = serial();
  const run = (generation: number | null, task: () => Promise<void>) =>
    network(() => task().catch((error) => emit({ type: "Error", generation, error: failure(error) })));
  const storeSent = (account: string, message: Message, context: string) => {
    try {
      storage.storeSent(account, message);
    } catch (error) {
      console.error(`${context}: ${failure(error)}`);
    }
  };

  return (command: Command) => {
    switch (command.type) {
      case "Register":
        avatars.register(command.account);
        return background.register(command.account, command.expanded);
      case "RetainAccounts":
        background.retainAccounts(command.accounts);
        return avatars.retainAccounts(command.accounts);
      case "Expanded":
        return background.expanded(command.email, command.expanded);
      case "Focus":
        return background.focus(command.account, command.folder);
      case "Select":
        return bodies.select(command.selection);
      case "Body":
        return bodies.push(command.request);
      case "Avatar":
        return avatars.push(command.email);
      case "Stop":
        bodies.close();
        background.close();
        avatars.close();
        return process.exit();
      case "ParcelHistory":
        return parcels(() => history(storage, bodies, emit, parcelConnections, command));
      case "LoadSenderPage": {
        const { account, folder, sender, generation, senderGeneration, before, limit } = command;
        try {
          const messages = storage.senderPage(account.email, folder, sender, before, limit + 1);
          return emit({ type: "SenderPage", generation, senderGeneration, messages: messages.slice(0, limit), hasMore: messages.length > limit });
        } catch (error) {
          return emit({ type: "SenderPageError", generation, senderGeneration, error: failure(error) });
        }
      }
      case "CalendarHistory": {
        const { account, uid, generation } = command;
        return void attempt(() => storage.calendarMessages(account.email, uid)).then((result) => emit({ type: "CalendarHistory", generation, uid, result }));
      }
      case "RelatedSent": {
        const { account, folder, messages, generation, selection } = command;
        try {
          const related = storage.relatedSent(account.email, folder, messages);
          for (const item of related) prepareDisplay(item.message);
          return emit({ type: "RelatedSent", generation, selection, messages: related });
        } catch (error) {
          return emit({ type: "Error", generation: null, error: `Could not load outgoing messages: ${failure(error)}` });
        }
      }
      case "FlushNotifications":
        return run(null, async () => {
          for (const [account, folder, validity] of storage.notificationFolders()) {
            const messages = storage.pendingNotifications(account, folder, validity);
            if (messages.length) emit({ type: "NewMail", account, folder, validity, messages });
          }
        });
      case "NotificationsHandled": {
        const { account, folder, validity, uids } = command;
        return run(null, async () => storage.acknowledgeNotifications(account, folder, validity, uids));
      }
      case "OpenNotification": {
        const { account, validity, uid } = command;
        return run(null, async () => {
          const result = await attempt(() => (storage.validity(account, "INBOX") === validity ? storage.message(account, "INBOX", uid) : null));
          emit({ type: "NotificationOpened", account, result });
        });
      }
      case "CalendarReply": {
        const { account, message, event, response } = command;
        return run(null, async () => {
          const result = await attempt(async () => {
            const sent = await calendar.sendReply(account, message, event, response);
            storeSent(account.email, sent, "Could not cache calendar response");
            return sent;
          });
          emit({ type: "CalendarReplied", account: account.email, uid: event.uid ?? "", recurrenceId: event.recurrenceId, result });
        });
      }
      case "Unsubscribe": {
        const { account, folder, uid, messageId } = command;
        return run(null, async () => {
          const result = await attempt(() => unsubscribe.execute(account, folder, uid, messageId, storage, connections));
          emit({ type: "Unsubscribe", account: account.email, folder, uid, messageId, result });
        });
      }
      case "SaveDraft": {
        const { account, draft, target, request } = command;
        return run(null, async () => emit({ type: "DraftSaved", request, result: await attempt(() => draftSave.save(account, draft, target, storage)) }));
      }
      case "Compose": {
        const { account, draft, target, request } = command;
        return run(null, async () => {
          const result = await attempt(async () => {
            const message = await smtp.send(account, await drafts.prepareSend(account, draft, target));
            storeSent(account.email, message, "Could not cache sent message");
            const cleanup = target && (await attempt(() => drafts.deleteDraft(account, target, storage)));
            return { message, cleanupError: cleanup && !cleanup.ok ? cleanup.error : null };
          });
          emit({ type: "Composed", request, result });
          if (result.ok) emit({ type: "SentCacheChanged", account: account.email });
        });
      }
      case "DeleteDraft": {
        const { account, target, request } = command;
        return run(null, async () => {
          const result = await attempt(async () => {
            await drafts.deleteDraft(account, target, storage);
            return null;
          });
          emit({ type: "DraftDeleted", request, result });
          if (result.ok) emit({ type: "SentCacheChanged", account: account.email });
        });
      }
      case "SentBody": {
        const { account, folder, uid, generation, selection } = command;
        return run(null, async () => {
          const result = await attempt(async () => {
            const validity = storage.validity(account.email, folder);
            const cached = storage.message(account.email, folder, uid);
            if (!cached) throw new Error("Outgoing message is no longer cached");
            ensureDraftId(cached, folder);
            if (cached.bodyLoaded) return prepared(cached);
            const message = await connections.execute(account, (mail) => mail.bodyWithValidity(folder, uid, validity, true));
            message.isDraft ||= cached.isDraft;
            if (message.isDraft && !message.messageId) message.messageId = cached.messageId;
            const stored = storage.storeBody(account.email, folder, validity, message);
            if (!stored) throw new Error("Outgoing mailbox changed while loading");
            return prepared(stored);
          });
          emit({ type: "SentBody", generation, selection, folder, uid, result });
        });
      }
      case "UndoSpam": {
        const { account, folder, originals } = command;
        return run(null, async () => {
          const outcome = await senderActions
            .undoSpam(account, folder, originals, storage, emit)
            .catch((error) => ({ messages: null, restored: [], error: failure(error) }));
          emit({ type: "SpamUndoFinished", account: account.email, folder, originals, ...outcome });
          background.refresh();
        });
      }
      case "SenderAction": {
        const { account, folder, sender, action } = command;
        return run(null, async () => {
          const outcome = await senderActions
            .execute(account, folder, sender, action, storage, emit)
            .catch((error) => ({ messages: null, error: failure(error), removed: [] }));
          emit({ type: "SenderActionFinished", account: account.email, folder, sender, ...outcome });
          background.refresh();
        });
      }
      case "Discover":
        return run(null, async () => {
          background.restoreStarted(storage.lastSyncStarted());
          const discovered = accounts.discover();
          for (const account of discovered) background.restoreFolders(account.email, storage.syncFolders(account.email));
          emit({ type: "Accounts", accounts: discovered });
          for (const { email } of discovered) {
            emit({ type: "UnreadSnapshot", account: email, folders: storage.unread(email) });
            const folders = storage.folders(email);
            if (folders.length) emit({ type: "Folders", account: email, folders });
          }
          emit({ type: "SidebarReady" });
        });
      case "Sync":
        return run(null, async () => {
          if (background.needsStartTime()) {
            const started = Math.floor(Date.now() / 1000);
            storage.recordSyncStarted(started);
            background.restoreStarted(started);
          }
          background.refresh();
        });
      case "Folders": {
        const { account } = command;
        return run(null, async () => {
          const cached = storage.folders(account.email);
          if (cached.length) emit({ type: "Folders", account: account.email, folders: cached });
          const folders = await connections.execute(account, (mail) => mail.folders());
          storage.storeFolders(account.email, folders);
          emit({ type: "Folders", account: account.email, folders });
        });
      }
      case "Load": {
        const { account, folder, generation } = command;
        return run(generation, async () => {
          emit({ type: "Messages", generation, messages: storage.senderHeaders(account.email, folder), cached: true });
          const revision = storage.readRevision();
          const [validity, messages, uids] = await connections.execute(account, (mail) => mail.headers(folder));
          storage.reconcileSince(account.email, folder, validity, messages, uids, revision);
          emit({ type: "Messages", generation, messages: storage.senderHeaders(account.email, folder), cached: false });
          const unread = await connections.execute(account, (mail) => mail.hasUnread(folder));
          storage.storeUnread(account.email, folder, unread);
          emit({ type: "Unread", account: account.email, folders: [[folder, unread]] });
        });
      }
    }
  };
}

self.onmessage = ({ data: path }: MessageEvent<string>) => {
  const handle = serve(path, (event: Event) => self.postMessage(event));
  self.onmessage = ({ data }: MessageEvent<Command>) => handle(data);
};
