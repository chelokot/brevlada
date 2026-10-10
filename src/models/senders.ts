import { matches, type Message, sortGroups } from ".";
import { parse } from "./address";

export function identity(message: Message): [name: string, address: string] {
  const [first] = parse(message.sender) ?? [];
  return first && !Array.isArray(first) ? [first.name ?? "", first.addr] : ["", message.sender.trim()];
}

export const address = (raw: string) => raw.trim().replace(/^[<>]+|[<>]+$/g, "").trim().toLowerCase();

export const key = (message: Message) => address(identity(message)[1]);

export function preview(messages: Message[]) {
  const found = messages.find((message) => message.searchMatch);
  if (found) return found;
  const order = (message: Message, best: Message) => Number(best.isRead) - Number(message.isRead) || message.timestamp - best.timestamp || message.uid - best.uid;
  return messages.reduce<Message | null>((best, message) => (best === null || order(message, best) >= 0 ? message : best), null);
}

export function groups(messages: Message[], query: string) {
  const senders = new Map<string, [Message, ...Message[]]>();
  for (const message of messages) {
    const sender = key(message);
    const group = senders.get(sender);
    if (group) group.push(message);
    else senders.set(sender, [message]);
  }
  return sortGroups([...senders.values()].filter((group) => group.some((message) => matches(message, query))));
}
