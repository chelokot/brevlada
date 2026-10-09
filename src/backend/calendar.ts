import type { Account, Draft, Message } from "../models";
import { label, reply, type Event, type Response } from "../models/calendar";
import { encode } from "./attachments";
import { send } from "./smtp";

export const sendReply = (account: Account, original: Message, event: Event, response: Response) => send(account, draftReply(account, original, event, response));

export function draftReply(account: Account, original: Message, event: Event, response: Response): Draft {
  const calendar = reply(event, account.email, response);
  const part = encode("response.ics", "text/calendar", new TextEncoder().encode(calendar)).replace("Content-Type: text/calendar", "Content-Type: text/calendar; method=REPLY; charset=UTF-8");
  const inReplyTo = original.messageId || null;
  const references = inReplyTo === null || original.references.includes(inReplyTo) ? original.references : [...original.references, inReplyTo];
  if (event.organizerEmail === null) throw new Error("Organizer email is unavailable");
  return {
    attachmentsLoaded: true,
    to: event.organizerEmail,
    cc: "",
    subject: `Re: ${original.subject}`,
    text: `${label(response)}: ${event.name}\n\n${account.email} responded ${label(response).toLowerCase()} to this invitation.`,
    html: null,
    attachments: [part],
    attachmentNames: ["response.ics"],
    removedAttachments: [],
    attachmentSource: null,
    inReplyTo,
    references,
  };
}
