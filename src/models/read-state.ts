import type { Message } from ".";

const identity = ({ uid, messageId, uidValidity }: Message, validity = uidValidity) => JSON.stringify([uid, messageId, validity]);

export function merge(messages: Iterable<Message>, previous: Iterable<Message>) {
  const newest = new Map<string, { read: Message; flag: Message }>();
  for (const message of previous) {
    const id = identity(message);
    const entry = newest.get(id);
    if (!entry) newest.set(id, { read: message, flag: message });
    else {
      if (message.readRevision > entry.read.readRevision) entry.read = message;
      if (message.flagRevision > entry.flag.flagRevision) entry.flag = message;
    }
  }
  for (const message of messages) {
    const old = newest.get(identity(message)) ?? (message.uidValidity === null ? undefined : newest.get(identity(message, null)));
    if (!old) continue;
    if (old.read.readRevision > message.readRevision) {
      message.isRead = old.read.isRead;
      message.readRevision = old.read.readRevision;
    }
    if (old.flag.flagRevision > message.flagRevision) {
      message.isFlagged = old.flag.isFlagged;
      message.flagRevision = old.flag.flagRevision;
    }
  }
}

export { merge as mergeInto };
