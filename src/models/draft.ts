import type { Message, SentMessage } from ".";

export interface Target {
  folder: string;
  uid: number;
  validity: number | null;
  messageId: string;
}

export interface Saved {
  item: SentMessage;
  originalParts: string[];
  cleanupError: string | null;
}

export interface Outcome {
  message: Message;
  cleanupError: string | null;
}
