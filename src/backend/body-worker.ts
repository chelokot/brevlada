import { prepareDisplay } from "../models";
import type { BodyQueue } from "./body-queue";
import { Connections } from "./connections";
import { normalizeMessageId } from "./parser";
import { failure, type BodyRequest, type Emit } from "./protocol";
import type { Storage } from "./storage";

export async function start(storage: Storage, queue: BodyQueue, emit: Emit) {
  const connections = new Connections();
  for (let request = await queue.pop(); request; request = await queue.pop()) {
    if (!queue.current(request.selection)) continue;
    const { generation, selection, uid, markRead } = request;
    await load(storage, request, queue, emit, connections).catch((error) => {
      if (!queue.current(selection)) return;
      emit(markRead ? { type: "BodyError", generation, selection, uid, error: failure(error) } : { type: "PreviewError", generation, selection, uid });
    });
  }
}

export async function load(storage: Storage, request: BodyRequest, queue: BodyQueue, emit: Emit, connections: Connections) {
  const { account, folder, uid, generation, selection } = request;
  const validity = storage.validity(account.email, folder);
  let message = storage.message(account.email, folder, uid);
  if (!message) throw new Error("Message is no longer in this folder");
  if (!message.bodyLoaded || (message.bodyHtml.includes("cid:") && !message.inlineMediaLoaded)) {
    const fetched = await connections.executeBody(account, queue, selection, (mail) => mail.bodyWithValidity(folder, uid, validity, true));
    const cached = normalizeMessageId(message.messageId);
    if (cached && cached !== normalizeMessageId(fetched.messageId)) throw new Error("The mailbox changed. Reload the folder.");
    message = storage.storeBody(account.email, folder, validity, fetched);
    if (!message) throw new Error("Mailbox changed while loading message");
  }
  if (!queue.current(selection)) return;
  prepareDisplay(message);
  if (!request.markRead) {
    emit({ type: "Preview", generation, selection, message });
    return;
  }
  emit({ type: "Body", generation, selection, message });
  if (message.isRead) return;
  await connections.executeBody(account, queue, selection, (mail) => mail.markRead(folder, uid, validity));
  const read = storage.markReadCached(account.email, folder, validity, uid);
  if (!read) throw new Error("Mailbox changed while marking message read");
  prepareDisplay(read);
  if (queue.current(selection)) emit({ type: "Body", generation, selection, message: read });
  const unread = await connections.executeBody(account, queue, selection, (mail) => mail.hasUnread(folder));
  storage.storeUnread(account.email, folder, unread);
  emit({ type: "Unread", account: account.email, folders: [[folder, unread]] });
}
