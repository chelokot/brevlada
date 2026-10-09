import type { Message } from "..";
import { type Parcel, parseMessage, type Step } from "../parcel";
import { at } from "../schema";
import { key } from "../senders";
import { fromTimestamp, parse, rfc3339, timestamp, toRfc3339 } from "../time";

export interface Identifier {
  kind: "Order" | "Tracking";
  value: string;
}

export function orderId(parcel: Parcel) {
  const id = parcel.orderNumber === null ? "" : parcel.orderNumber.trim();
  return id || null;
}

export function identifier(parcel: Parcel): Identifier | null {
  const order = orderId(parcel);
  if (order !== null) return { kind: "Order", value: order };
  const tracking = at(parcel.details, "trackingNumber");
  return typeof tracking === "string" && tracking.trim() ? { kind: "Tracking", value: tracking.trim() } : null;
}

const normalized = (value: string | null) => (value === null ? null : value.trim().toLowerCase());

function eventTime(value: string) {
  const date = rfc3339(value) ?? parse(value, "%Y-%m-%d");
  return date && timestamp(date);
}

export function sequence(parcel: Parcel, source: Message, messages: Iterable<Message>): Parcel {
  const id = identifier(parcel);
  const sender = key(source);
  if (id === null || !sender) return { ...parcel };
  const updates: [number, Parcel][] = [[source.timestamp, parcel]];
  for (const message of messages) {
    if (key(message) !== sender) continue;
    for (const related of message.parcels.length > 0 ? message.parcels : parseMessage(message)) {
      const other = identifier(related);
      if (other !== null && other.kind === id.kind && other.value === id.value) updates.push([message.timestamp, related]);
    }
  }
  updates.sort(([left], [right]) => left - right);
  const events: { time: number; dated: boolean; step: Step }[] = [];
  for (const [stamp, update] of updates) {
    const status = at(update.details, "deliveryStatus");
    const implied = update.steps.length === 0 && typeof status === "string" && status.trim() && !status.includes("://");
    for (const original of implied ? [{ name: status, date: null, location: null }] : update.steps) {
      const dated = original.date !== null;
      const time = (original.date === null ? null : eventTime(original.date)) ?? stamp;
      const step = { ...original, date: original.date ?? toRfc3339(fromTimestamp(stamp)) };
      const duplicate = events.find(
        (old) =>
          normalized(old.step.name) === normalized(step.name) &&
          normalized(old.step.location) === normalized(step.location) &&
          (old.step.date === step.date || !old.dated || !dated),
      );
      if (!duplicate) events.push({ time, dated, step });
      else if (dated && !duplicate.dated) Object.assign(duplicate, { time, dated, step });
    }
  }
  return { ...parcel, steps: events.sort((left, right) => left.time - right.time).map(({ step }) => step) };
}
