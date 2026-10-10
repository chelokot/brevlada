import { parse as dom } from "../dom";
import { at, isObject, type Json, microdata, nested, scopes, scripts, term, values } from "../schema";
import { merge, sameReservation, type Kind, type Reservation, type Ticket } from "../ticket";
import { normalize } from "./dates";
import { kind as isKind, named, place, seat, text, url } from "./fields";

const ROOTS = new Set(["EventReservation", "BusReservation", "TrainReservation", "FlightReservation", "Ticket"]);
const KINDS: [string, Kind][] = [
  ["BusReservation", "Bus"],
  ["TrainReservation", "Train"],
  ["FlightReservation", "Flight"],
  ["EventReservation", "Event"],
  ["Ticket", "Ticket"],
];
const KEYS: Record<Kind, [departure: string, arrival: string, provider: string, service: string]> = {
  Bus: ["departureBusStop", "arrivalBusStop", "busCompany", "busNumber"],
  Train: ["departureStation", "arrivalStation", "trainCompany", "trainNumber"],
  Flight: ["departureAirport", "arrivalAirport", "airline", "flightNumber"],
  Event: ["", "", "organizer", ""],
  Ticket: ["", "", "organizer", ""],
};
const FALLBACK: Record<Kind, string> = { Bus: "Bus journey", Train: "Train journey", Flight: "Flight", Event: "Event ticket", Ticket: "Ticket" };

export function parse(html: string): Reservation[] {
  if (!html.includes("Reservation") && !html.includes("Ticket")) return [];
  const root = dom(html);
  const reservations: Reservation[] = [];
  for (const value of scripts(root)) collect(value, reservations);
  for (const element of scopes(root)) if (!nested(element, (type) => ROOTS.has(term(type)))) collect(microdata(element), reservations);
  return reservations;
}

function tickets(value: Json, holder: string | null): Ticket[] {
  if (Array.isArray(value)) return value.flatMap((item) => tickets(item, holder));
  if (!isObject(value)) return [];
  const ticket = {
    number: text(at(value, "ticketNumber")),
    holder: named(at(value, "underName")) ?? holder,
    seat: seat(at(value, "ticketedSeat")),
    token: text(at(value, "ticketToken")),
  };
  return ticket.number === null && ticket.token === null && ticket.seat === null ? [] : [ticket];
}

function reservation(value: Json): Reservation | null {
  const match = KINDS.find(([name]) => isKind(value, name));
  if (!match) return null;
  const [, kind] = match;
  const holder = named(at(value, "underName"));
  const list = tickets(kind === "Ticket" ? value : at(value, "reservedTicket"), holder);
  if ((kind === "Event" || kind === "Ticket") && list.length === 0) return null;
  const source = kind === "Ticket" ? value : at(value, "reservationFor");
  const [departureKey, arrivalKey, providerKey, serviceKey] = KEYS[kind];
  const departure = place(at(source, departureKey));
  const arrival = place(at(source, arrivalKey));
  const name =
    departure !== null && arrival !== null
      ? `${named(at(source, departureKey)) ?? departure} → ${named(at(source, arrivalKey)) ?? arrival}`
      : (named(source) ?? text(at(value, "name")) ?? FALLBACK[kind]);
  const start = text(at(source, "departureTime")) ?? text(at(source, "startDate"));
  if (start === null && list.length === 0) return null;
  const end = text(at(source, "arrivalTime")) ?? text(at(source, "endDate"));
  const status = text(at(value, "reservationStatus"));
  const link = url(at(value, "url")) ?? url(at(source, "url"));
  return {
    kind,
    number: text(at(value, "reservationId")) ?? text(at(value, "reservationNumber")),
    status: status === null ? null : term(status),
    name,
    start: start === null ? null : normalize(start),
    end: end === null ? null : normalize(end),
    departure,
    arrival,
    location: place(at(source, "location")),
    provider: named(at(source, providerKey)) ?? named(at(value, "provider")),
    service: text(at(source, serviceKey)),
    url: kind === "Flight" ? (link ?? url(at(value, "checkinUrl"))) : link,
    holder,
    tickets: list,
  };
}

function collect(value: Json, reservations: Reservation[]) {
  const found = reservation(value);
  if (found) {
    const old = reservations.find((old) => sameReservation(old, found));
    if (old) merge(old, found);
    else reservations.push(found);
  } else if (Array.isArray(value)) value.forEach((item) => collect(item, reservations));
  else if (isObject(value)) values(value).forEach((item) => collect(item, reservations));
}
