import type { Message } from "../models";
import { parseMessage } from "../models/parcel";
import { identifier, type Identifier } from "../models/parcel/history";
import { key } from "../models/senders";
import type { BodyQueue } from "./body-queue";
import type { Connections } from "./connections";
import { failure, type Command, type Emit } from "./protocol";
import type { Storage } from "./storage";

export async function history(
  storage: Storage,
  queue: BodyQueue,
  emit: Emit,
  connections: Connections,
  { account, folder, sender, identifier: id, generation, selection }: Extract<Command, { type: "ParcelHistory" }>,
) {
  if (!id.value.trim() || !sender || !queue.current(selection)) return;
  try {
    let messages = storage.parcelSenderMessages(account.email, folder, sender, id.value);
    const send = () => {
      if (queue.current(selection)) emit({ type: "ParcelHistory", generation, selection, sender, identifier: id, messages: matching(messages, sender, id) });
    };
    send();
    const validity = storage.validity(account.email, folder);
    const uids = await connections.executeBody(account, queue, selection, (mail) => mail.deliveryUids(folder, validity, sender, id.value));
    for (const uid of uids) {
      if (!queue.current(selection)) return;
      if (messages.some((message) => message.uid === uid && message.bodyLoaded)) continue;
      const fetched = await connections.executeBody(account, queue, selection, (mail) => mail.bodyWithValidity(folder, uid, validity, false));
      const cached = storage.message(account.email, folder, uid);
      const message = storage.storeBody(account.email, folder, validity, fetched) ?? (cached ? null : fetched);
      if (message) {
        messages = [...messages.filter((old) => old.uid !== uid), message];
        send();
      }
    }
  } catch (error) {
    if (queue.current(selection)) console.error(`Could not load delivery history: ${failure(error)}`);
  }
}

export function matching(messages: Message[], sender: string, id: Identifier) {
  return messages.flatMap((message) => {
    if (key(message) !== sender) return [];
    const parcels = (message.parcels.length ? message.parcels : parseMessage(message)).filter((parcel) => {
      const found = identifier(parcel);
      return found !== null && found.kind === id.kind && found.value === id.value;
    });
    return parcels.length ? [{ ...message, parcels }] : [];
  });
}
