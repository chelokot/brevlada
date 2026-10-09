import type { Message } from "..";
import { type Event, events, sameEvent } from "../calendar";
import { key } from "../senders";
import { sameAscii } from "../text";

const LABELS = new Map([
  ["ACCEPTED", "Accepted"],
  ["TENTATIVE", "Maybe"],
  ["DECLINED", "Declined"],
  ["DELEGATED", "Delegated"],
  ["NEEDS-ACTION", "Awaiting response"],
]);

export const statusLabel = (status: string) => LABELS.get(status) ?? status;

export function snapshot(source: Event, messages: Iterable<Message>): Event {
  const updates: [Event, Message][] = [];
  for (const message of messages)
    for (const event of events(message)) if (sameEvent(source, event) && event.organizerEmail === source.organizerEmail) updates.push([event, message]);
  const latest = updates
    .filter(([event]) => event.method !== "REPLY")
    .reduce<[Event, Message] | null>(
      (best, update) =>
        best === null || (update[0].sequence - best[0].sequence || update[0].stamp - best[0].stamp || update[1].timestamp - best[1].timestamp) >= 0 ? update : best,
      null,
    );
  const base = latest === null ? source : latest[0];
  const result = { ...base, attendees: base.attendees.map((attendee) => ({ ...attendee })) };
  const replies = updates
    .filter(([event]) => event.method === "REPLY" && event.sequence === result.sequence && event.stamp >= result.stamp)
    .sort(([left, older], [right, newer]) => left.stamp - right.stamp || older.timestamp - newer.timestamp || older.uid - newer.uid);
  for (const [reply, message] of replies) {
    const sender = key(message);
    for (const attendee of reply.attendees) {
      const current = sameAscii(attendee.email, sender) ? result.attendees.find((current) => sameAscii(current.email, attendee.email)) : undefined;
      if (current) current.status = attendee.status;
    }
  }
  if (result.method === "CANCEL") {
    result.status = "CANCELLED";
    result.invitation = false;
  }
  return result;
}
