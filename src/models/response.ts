import type { Message } from ".";
import { format, parse } from "./address";
import { address, key } from "./senders";
import { asciiLower } from "./text";

export type Action = "Reply" | "ReplyAll" | "Forward";

const addresses = (value: string) => (parse(value) ?? []).flat();

export function recipients(message: Message, account: string, action: Action): [to: string, cc: string] {
  if (action === "Forward") return ["", ""];
  const own = key(message) === address(account);
  const target = own ? message.recipients : addresses(message.replyTo).length > 0 ? message.replyTo : message.sender;
  const seen = new Set([address(account)]);
  const unique = (value: string) =>
    addresses(value)
      .filter(({ addr }) => !seen.has(asciiLower(addr)) && seen.add(asciiLower(addr)))
      .map(format);
  const to = unique(target);
  if (action !== "ReplyAll") return [to.join(", "), ""];
  to.push(...unique(message.recipients));
  return [to.join(", "), unique(message.cc).join(", ")];
}

export function subject(message: Message, action: Action) {
  const subject = message.subject.trim();
  const lower = asciiLower(subject);
  const prefixed = action === "Forward" ? lower.startsWith("fwd:") || lower.startsWith("fw:") : lower.startsWith("re:");
  return prefixed ? subject : `${action === "Forward" ? "Fwd" : "Re"}: ${subject}`;
}

export function forwardHeader(message: Message) {
  const cc = message.cc.trim() ? `Cc: ${message.cc}\n` : "";
  return `---------- Forwarded message ----------\nFrom: ${message.sender}\nDate: ${message.date}\nSubject: ${message.subject}\nTo: ${message.recipients}\n${cc}\n`;
}
