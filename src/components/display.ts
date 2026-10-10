import { type Message, SUBJECT_PREFIX } from "../models";
import { identity } from "../models/senders";
import { format, local } from "../models/time";

export const sender = (message: Message) => identity(message);

export function senderName(message: Message) {
  const [name, email] = sender(message);
  return name || email || "Unknown Sender";
}

const TIMED = ["Today %H:%M", "Yesterday %H:%M", "%a %H:%M", "%b %d %H:%M", "%m/%d/%y %H:%M"] as const;
const DATED = ["%H:%M", "Yesterday", "%A", "%b %d", "%b %d, %Y"] as const;

export function date(message: Message, withTime: boolean) {
  const days = Math.trunc((Date.now() / 1000 - message.timestamp) / 86400);
  const range = days === 0 ? 0 : days === 1 ? 1 : days >= 2 && days < 7 ? 2 : days >= 7 && days < 365 ? 3 : 4;
  return format(local(message.timestamp), (withTime ? TIMED : DATED)[range]);
}

export function subject(message: Message) {
  return message.subject.replace(SUBJECT_PREFIX, "").trim() || "(No Subject)";
}
