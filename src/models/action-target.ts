import type { Message } from ".";
import { key } from "./senders";

export type ActionTarget = { kind: "Sender"; sender: string } | { kind: "Messages"; messages: [uid: number, messageId: string][] };

export const matches = (target: ActionTarget, message: Message) =>
  target.kind === "Sender" ? key(message) === target.sender : target.messages.some(([uid, id]) => uid === message.uid && id === message.messageId);

export const label = (target: ActionTarget) => (target.kind === "Sender" ? target.sender : "selected messages");
