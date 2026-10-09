import Gtk from "gi://Gtk?version=4.0";
import { card } from "../components/ticket";
import { key } from "../models/senders";
import { merge, type Reservation, sameReservation } from "../models/ticket";
import type { Source } from "./conversation";

export function ticketWidgets(messages: Source[]) {
  const slots = messages.map(([, , message]) => ({ message, widgets: new Array<Gtk.Widget>() }));
  const reservations: { slot: (typeof slots)[number]; provider: string; reservation: Reservation }[] = [];
  for (const slot of slots.toReversed()) {
    if (slot.message.isDraft) continue;
    const sender = key(slot.message);
    for (const reservation of slot.message.tickets) {
      const provider = reservation.provider === null ? sender : reservation.provider.toLowerCase();
      const older = reservations.find((older) => older.provider === provider && sameReservation(older.reservation, reservation));
      if (older) merge(older.reservation, reservation);
      else reservations.push({ slot, provider, reservation: structuredClone(reservation) });
    }
  }
  for (const { slot, reservation } of reservations) slot.widgets.push(card(reservation));
  return slots.map(({ widgets }) => widgets);
}
