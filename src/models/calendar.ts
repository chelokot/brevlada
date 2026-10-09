import type { Message } from ".";
import { parse as parseIcal } from "./calendar/ical";
import { add } from "./calendar/rsvp";
import { parse as parseHtml } from "./calendar/schema";
import { sameAscii } from "./text";
import { compare, rfc3339 } from "./time";

export { parseHtml, parseIcal };
export { label as dateLabel } from "./calendar/dates";
export { serialize as toIcal } from "./calendar/export";
export { reply } from "./calendar/reply";
export { compactReply, type Participant, participants, responseLabel } from "./calendar/responses";
export { snapshot, statusLabel } from "./calendar/scheduling";

export interface Rsvp {
  label: string;
  url: string;
}

export interface Attendee {
  email: string;
  name: string | null;
  status: string;
}

export interface Event {
  uid: string | null;
  recurrenceId: string | null;
  sequence: number;
  stamp: number;
  method: string | null;
  organizerEmail: string | null;
  attendees: Attendee[];
  name: string;
  start: string;
  end: string | null;
  timezone: string | null;
  location: string | null;
  organizer: string | null;
  description: string | null;
  url: string | null;
  status: string | null;
  rsvp: Rsvp[];
  invitation: boolean;
  calendar: string | null;
}

export type Response = "Accepted" | "Tentative" | "Declined";

export const event = (fields: Partial<Event> = {}): Event => ({
  uid: null,
  recurrenceId: null,
  sequence: 0,
  stamp: 0,
  method: null,
  organizerEmail: null,
  attendees: [],
  name: "",
  start: "",
  end: null,
  timezone: null,
  location: null,
  organizer: null,
  description: null,
  url: null,
  status: null,
  rsvp: [],
  invitation: false,
  calendar: null,
  ...fields,
});

export const status = (response: Response) => ({ Accepted: "ACCEPTED", Tentative: "TENTATIVE", Declined: "DECLINED" })[response];

export const label = (response: Response) => ({ Accepted: "Accepted", Tentative: "Maybe", Declined: "Declined" })[response];

export function isReply(message: Message) {
  if (message.isDraft) return false;
  const found = events(message);
  return found.length > 0 && found.every((event) => event.method === "REPLY");
}

export function events(message: Message): Event[] {
  if (message.displayPrepared) return message.calendarEvents;
  const result: Event[] = [];
  for (const cached of message.calendarEvents) {
    const parsed = cached.calendar === null ? [] : parseIcal(cached.calendar);
    const hydrated = parsed.find((event) => sameEvent(event, cached)) ?? parsed[0] ?? { ...cached, rsvp: [...cached.rsvp] };
    if (!result.some((old) => sameEvent(old, hydrated))) result.push(hydrated);
  }
  for (const event of parseHtml(message.bodyHtml)) {
    const old = result.find((old) => sameEvent(old, event));
    if (old) for (const action of event.rsvp) add(old.rsvp, action);
    else result.push(event);
  }
  return result;
}

export function sameEvent(event: Event, other: Event) {
  if (event.uid !== null && other.uid !== null) return event.uid === other.uid && event.recurrenceId === other.recurrenceId;
  if (event.name !== other.name) return false;
  if (event.start === other.start) return true;
  const [left, right] = [rfc3339(event.start), rfc3339(other.start)];
  return left !== null && right !== null && compare(left, right) === 0;
}

export const canReply = (event: Event, email: string) =>
  event.invitation &&
  event.uid !== null &&
  event.organizerEmail !== null &&
  event.status !== "CANCELLED" &&
  event.attendees.some((attendee) => sameAscii(attendee.email, email));
