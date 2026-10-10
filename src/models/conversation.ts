import { type Message, type SentMessage, subjectKey } from ".";
import { parse } from "./address";
import { key } from "./senders";
import { sameAscii } from "./text";

function sameConversation(incoming: Message, sent: Message) {
  const subject = subjectKey(incoming.subject);
  if (!subject || subject !== subjectKey(sent.subject)) return false;
  const sender = key(incoming);
  return (parse(sent.recipients) ?? []).flat().some(({ addr }) => sameAscii(addr, sender));
}

export const quotedMessageVisible = (message: Message, older: Iterable<Message>) =>
  [...older].some((item) => (item.messageId && message.references.includes(item.messageId)) || sameConversation(message, item) || sameConversation(item, message));

export function related(received: Message[], candidates: SentMessage[]) {
  const receivedIds = new Set(received.map((message) => message.messageId));
  const linked = new Set(received.flatMap((message) => [message.messageId, ...message.references]).filter((id) => id));
  const found = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { message } of candidates) {
      if (!message.messageId || receivedIds.has(message.messageId) || found.has(message.messageId)) continue;
      if (linked.has(message.messageId) || message.references.some((id) => linked.has(id)) || received.some((incoming) => sameConversation(incoming, message))) {
        found.add(message.messageId);
        linked.add(message.messageId);
        for (const id of message.references) linked.add(id);
        changed = true;
      }
    }
  }
  return candidates.filter(({ message }) => found.delete(message.messageId)).sort((left, right) => right.message.timestamp - left.message.timestamp);
}
