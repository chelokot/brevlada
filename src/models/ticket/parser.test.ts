import { expect, test } from "bun:test";
import { parseHtml, parseIcal, toIcal } from "../calendar";
import type { Json } from "../schema";
import { calendarEvent, parse, statusLabel, webUrl } from "../ticket";

const html = (value: Json) => `<script type='application/ld+json'>${JSON.stringify(value)}</script>`;

const bus = (holder: string, number: string, from: string, to: string) => ({
  "@type": "BusReservation",
  reservationNumber: "booking-one",
  reservationStatus: "http://schema.org/ReservationConfirmed",
  reservationFor: {
    "@type": "BusTrip",
    busNumber: "100",
    busCompany: { name: "Coach Co" },
    departureBusStop: { name: from },
    arrivalBusStop: { name: to },
    departureTime: "2026-10-08T13:50:00+02:00",
    arrivalTime: "2026-10-08T16:30:00+02:00",
  },
  reservedTicket: {
    "@type": "Ticket",
    ticketNumber: number,
    ticketToken: `https://example.com/ticket/${number}`,
    underName: { name: holder },
    ticketedSeat: { seatNumber: "12A" },
  },
});

test("groups passengers without combining separate journeys", () => {
  const reservations = parse(html({ "@graph": [bus("Alex", "one", "Prague", "Dresden"), bus("Sam", "two", "Prague", "Dresden"), bus("Alex", "three", "Dresden", "Prague")] }));
  expect(reservations.length).toBe(2);
  const [first] = reservations;
  if (!first) throw new Error("reservation expected");
  expect(first.tickets.length).toBe(2);
  expect(first.tickets[0]).toMatchObject({ holder: "Alex", seat: "Seat 12A" });
  expect(statusLabel(first)).toBe("Confirmed");
  const event = calendarEvent(first);
  const exported = event && toIcal(event);
  const [parsed] = parseIcal(exported ?? "");
  expect(parsed).toMatchObject({ name: "Prague → Dresden", start: "2026-10-08T11:50:00Z" });
  expect(parsed?.description).toContain("Alex · Seat 12A");
});

test("reads flight microdata without a boarding pass", () => {
  const reservations = parse(`<div itemscope itemtype="https://schema.org/FlightReservation">
            <meta itemprop="reservationNumber" content="flight-one">
            <link itemprop="checkinUrl" href="https://example.com/check-in">
            <div itemprop="underName" itemscope itemtype="https://schema.org/Person"><meta itemprop="name" content="Alex"></div>
            <div itemprop="reservationFor" itemscope itemtype="https://schema.org/Flight">
                <meta itemprop="flightNumber" content="FR123">
                <meta itemprop="departureTime" content="2026-10-08T13:50:00+02:00">
                <meta itemprop="arrivalTime" content="2026-10-08T15:00:00+01:00">
                <div itemprop="departureAirport" itemscope itemtype="https://schema.org/Airport"><meta itemprop="name" content="Prague"><meta itemprop="iataCode" content="PRG"></div>
                <div itemprop="arrivalAirport" itemscope itemtype="https://schema.org/Airport"><meta itemprop="name" content="London"><meta itemprop="iataCode" content="STN"></div>
            </div></div>`);
  expect(reservations.length).toBe(1);
  expect(reservations[0]).toMatchObject({
    kind: "Flight",
    name: "Prague → London",
    departure: "Prague (PRG)",
    holder: "Alex",
    url: "https://example.com/check-in",
    service: "FR123",
    tickets: [],
  });
});

test("event tickets accept arrays and leave appointments to calendar", () => {
  const event: { [key: string]: Json } = {
    "@type": ["https://schema.org/EventReservation"],
    reservationId: "event-one",
    underName: { name: "Alex" },
    reservationFor: { "@type": "MusicEvent", name: "Concert", startDate: "2026-10-09T20:00:00+02:00", location: { name: "Hall" } },
    reservedTicket: [
      { "@type": "Ticket", ticketNumber: 123, ticketToken: "qrCode:abcd", ticketedSeat: { seatSection: "A", seatRow: 4, seatNumber: 12 } },
      { "@type": "Ticket", ticketNumber: 124 },
    ],
  };
  const reservations = parse(html(event));
  expect(reservations.length).toBe(1);
  expect(reservations[0]?.tickets.length).toBe(2);
  expect(reservations[0]?.tickets[0]).toMatchObject({ number: "123", seat: "Section A · Row 4 · Seat 12" });
  expect(reservations[0]?.tickets[1]?.holder).toBe("Alex");
  const { reservedTicket, ...appointment } = event;
  expect(reservedTicket).toBeArray();
  expect(parse(html(appointment))).toEqual([]);
  expect(parseHtml(html(appointment)).length).toBe(1);
});

test("newer invoice keeps seats and cancellation status", () => {
  const original = bus("Alex", "one", "Prague", "Dresden");
  const { ticketedSeat, ...ticket } = original.reservedTicket;
  expect(ticketedSeat).toBeDefined();
  const invoice = { ...original, reservedTicket: ticket, reservationStatus: "https://schema.org/ReservationCancelled" };
  const reservations = parse(html([original, invoice]));
  expect(reservations.length).toBe(1);
  const [merged] = reservations;
  if (!merged) throw new Error("reservation expected");
  expect(merged.tickets.length).toBe(1);
  expect(merged.tickets[0]?.seat).toBe("Seat 12A");
  expect(statusLabel(merged)).toBe("Cancelled");
  expect(calendarEvent(merged)?.status).toBe("CANCELLED");
  expect(parse(html({ ...original, url: "javascript:alert(1)" }))[0]?.url).toBeNull();
  expect(webUrl("file:///tmp/pass")).toBe(false);
  expect(webUrl("https:")).toBe(false);
  expect(webUrl("https://example.com/a b")).toBe(true);
  expect(parse("<script type='application/ld+json'>{broken}</script>")).toEqual([]);
});
