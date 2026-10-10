import { event, type Event } from "./calendar";

export { dateLabel, dayLabel, timeLabel } from "./ticket/dates";
export { webUrl } from "./ticket/fields";
export { parse } from "./ticket/parser";

export type Kind = "Event" | "Bus" | "Train" | "Flight" | "Ticket";

export interface Ticket {
  number: string | null;
  holder: string | null;
  seat: string | null;
  token: string | null;
}

export interface Reservation {
  kind: Kind;
  number: string | null;
  status: string | null;
  name: string;
  start: string | null;
  end: string | null;
  departure: string | null;
  arrival: string | null;
  location: string | null;
  provider: string | null;
  service: string | null;
  url: string | null;
  holder: string | null;
  tickets: Ticket[];
}

const STATUSES = new Map([
  ["ReservationConfirmed", "Confirmed"],
  ["ReservationCancelled", "Cancelled"],
  ["ReservationPending", "Pending"],
  ["ReservationHold", "On hold"],
]);

function sameTicket(ticket: Ticket, other: Ticket) {
  if (ticket.number === other.number && ticket.holder === other.holder && ticket.seat === other.seat && ticket.token === other.token) return true;
  if (ticket.number !== null && other.number !== null) return ticket.number === other.number && ticket.holder === other.holder;
  return ticket.token !== null && ticket.token === other.token && ticket.holder === other.holder;
}

export function sameReservation(reservation: Reservation, other: Reservation) {
  const { kind, name, start, departure, arrival, location, number, tickets } = reservation;
  const sameNumber =
    number !== null && other.number !== null
      ? number === other.number
      : number === null && other.number === null && tickets.some((ticket) => other.tickets.some((candidate) => sameTicket(ticket, candidate)));
  return (
    kind === other.kind &&
    name === other.name &&
    start === other.start &&
    departure === other.departure &&
    arrival === other.arrival &&
    location === other.location &&
    sameNumber
  );
}

export function merge(reservation: Reservation, newer: Reservation) {
  for (const ticket of newer.tickets) {
    const old = reservation.tickets.find((old) => sameTicket(old, ticket));
    if (old) {
      old.holder = ticket.holder ?? old.holder;
      old.seat = ticket.seat ?? old.seat;
      old.token = ticket.token ?? old.token;
    } else reservation.tickets.push({ ...ticket });
  }
  reservation.status = newer.status ?? reservation.status;
  reservation.end = newer.end ?? reservation.end;
  reservation.provider = newer.provider ?? reservation.provider;
  reservation.service = newer.service ?? reservation.service;
  reservation.url = newer.url ?? reservation.url;
  reservation.holder = newer.holder ?? reservation.holder;
}

export function calendarEvent(reservation: Reservation): Event | null {
  const { start, number, arrival, tickets } = reservation;
  if (start === null) return null;
  const description = [
    ...(number === null ? [] : [`Booking: ${number}`]),
    ...(arrival === null ? [] : [`Arrival: ${arrival}`]),
    ...tickets.map((ticket) => [ticket.holder, ticket.seat].filter((part) => part !== null).join(" · ")).filter((text) => text),
  ];
  return event({
    name: reservation.name,
    start,
    end: reservation.end,
    location: reservation.location ?? reservation.departure,
    organizer: reservation.provider,
    description: description.length > 0 ? description.join("\n") : null,
    url: reservation.url,
    status: reservation.status === "ReservationCancelled" ? "CANCELLED" : null,
  });
}

export const statusLabel = (reservation: Reservation) => (reservation.status === null ? null : (STATUSES.get(reservation.status) ?? null));
