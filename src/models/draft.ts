import type { Draft, Message, SentMessage } from ".";

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

export const target = (folder: string, { uid, uidValidity, messageId }: Message): Target => ({ folder, uid, validity: uidValidity, messageId });

export const fromMessage = (message: Message): Draft => ({
  attachmentsLoaded: false,
  to: message.recipients,
  cc: message.cc,
  subject: message.subject,
  text: message.bodyText,
  html: message.bodyHtml ? message.bodyHtml : null,
  attachments: [],
  attachmentNames: [...message.attachments],
  removedAttachments: [],
  attachmentSource: null,
  inReplyTo: message.inReplyTo,
  references: [...message.references],
});
