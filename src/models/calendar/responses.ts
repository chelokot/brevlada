import type { Message } from "..";
import { renderedCalendar } from "../attachment";
import { type Attendee, type Event, events, sameEvent } from "../calendar";
import { identity, key } from "../senders";
import { sameAscii } from "../text";
import { format, local } from "../time";
import { statusLabel } from "./scheduling";

export interface Participant {
  attendee: Attendee;
  respondedAt: number | null;
  unread: boolean;
}

export function responseLabel({ attendee, respondedAt }: Participant) {
  const status = statusLabel(attendee.status);
  return respondedAt === null ? status : `${status} · ${format(local(respondedAt), "%-d %b %Y %H:%M")}`;
}

function matches(source: Event, reply: Event, message: Message) {
  const sender = key(message);
  return (
    source.uid !== null &&
    sameEvent(source, reply) &&
    source.organizerEmail !== null &&
    source.organizerEmail === reply.organizerEmail &&
    reply.method === "REPLY" &&
    reply.attendees.some((attendee) => sameAscii(attendee.email, sender) && source.attendees.some((invited) => sameAscii(invited.email, attendee.email)))
  );
}

export function participants(event: Event, messages: Iterable<Message>) {
  const result = event.attendees.map((attendee): Participant => ({ attendee: { ...attendee }, respondedAt: null, unread: false }));
  const replies: [Event, Message][] = [];
  for (const message of messages)
    for (const reply of events(message)) if (matches(event, reply, message) && reply.sequence === event.sequence && reply.stamp >= event.stamp) replies.push([reply, message]);
  replies.sort(([left, older], [right, newer]) => right.sequence - left.sequence || right.stamp - left.stamp || newer.timestamp - older.timestamp || newer.uid - older.uid);
  for (const [reply, message] of replies) {
    const sender = key(message);
    const person = result.find((person) => sameAscii(person.attendee.email, sender));
    if (!person || person.respondedAt !== null) continue;
    const [name] = identity(message);
    if (person.attendee.name === null && name) person.attendee.name = name;
    person.respondedAt = reply.stamp > 0 ? reply.stamp : message.timestamp;
    person.unread = !message.isRead;
  }
  return result;
}

export function compactReply(message: Message, invitations: Event[]) {
  if (message.isDraft || message.parcels.length > 0 || message.attachments.some((_, index) => !renderedCalendar(message, index))) return false;
  const replies = events(message);
  return replies.length > 0 && replies.every((reply) => invitations.some((source) => matches(source, reply, message)));
}
