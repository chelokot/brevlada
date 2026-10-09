import type { Account } from "../models";
import type { Connections } from "./connections";
import * as http from "./http";
import { normalizeMessageId } from "./parser";
import type { UnsubscribeOutcome } from "./protocol";
import type { Storage } from "./storage";

export async function execute(account: Account, folder: string, uid: number, messageId: string, storage: Storage, connections: Connections): Promise<UnsubscribeOutcome> {
  const message = storage.message(account.email, folder, uid);
  if (!message) throw new Error("Message is no longer cached");
  if (normalizeMessageId(message.messageId) !== normalizeMessageId(messageId)) throw new Error("The mailbox changed. Reload the folder.");
  let unsubscribe = message.unsubscribe;
  if (!unsubscribe) throw new Error("No unsubscribe link in this message");
  if (unsubscribe.oneClick === null) {
    const validity = storage.validity(account.email, folder);
    const header = await connections.execute(account, (mail) => mail.headerWithValidity(folder, uid, validity));
    if (normalizeMessageId(header.messageId) !== normalizeMessageId(messageId)) throw new Error("The mailbox changed. Reload the folder.");
    storage.storeUnsubscribe(account.email, folder, validity, header);
    unsubscribe = header.unsubscribe;
    if (!unsubscribe) throw new Error("No unsubscribe link in this message");
  }
  const { url, oneClick } = unsubscribe;
  return oneClick && (await http.unsubscribe(url)) === "Done" ? { kind: "Done" } : { kind: "Open", url };
}
