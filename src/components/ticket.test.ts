import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import type { Reservation, Ticket } from "../models/ticket";
import { SMALL_SPACING } from "../theme";
import { buttons, capture, descendants, labels, settle, useDisplay } from "./testing";
import { card } from "./ticket";

const display = useDisplay();

const ticket = (fields: Partial<Ticket>): Ticket => ({ holder: null, number: null, seat: null, token: null, ...fields });

test("ticket card keeps passenger actions and wraps at narrow widths", async () => {
  const icons = Gtk.IconTheme.get_for_display(display);
  expect(icons.has_icon("ticket-symbolic")).toBe(true);
  expect(icons.has_icon("person-symbolic")).toBe(true);
  const reservation: Reservation = {
    kind: "Bus",
    name: "Prague → Dresden",
    number: "booking-one",
    status: "ReservationConfirmed",
    provider: "Coach Co",
    service: "100",
    departure: "Prague central bus station",
    arrival: "Dresden central bus station",
    start: "2026-10-08T13:00:00+02:00",
    end: "2026-10-08T15:00:00+02:00",
    location: null,
    url: null,
    holder: null,
    tickets: [
      ticket({ holder: "Alex <Smith>", number: "one", seat: "Seat 12A", token: "https://example.com/pass" }),
      ticket({ holder: "Sam", number: "two", seat: "Seat 12B", token: "qrCode:abcd" }),
      ticket({ holder: "Lee", number: "three", token: "javascript:alert(1)" }),
    ],
  };
  const content = card(reservation);
  expect(content.has_css_class("ticket-card")).toBe(true);
  expect(descendants(content).some((widget) => widget instanceof Gtk.Label && widget.get_use_markup())).toBe(false);
  const texts = labels(content);
  for (const expected of [
    "Alex <Smith>",
    "Sam",
    "Lee",
    "Confirmed",
    "Seat 12A",
    "Seat 12B",
    "Coach Co · 100 · Booking booking-one",
    "8 Oct 2026",
    "13:00 · Prague central bus station",
    "15:00 · Dresden central bus station",
    "Save to Calendar",
  ])
    expect(texts).toContain(expected);
  expect(texts.some((text) => text === "Departure" || text === "Arrival")).toBe(false);
  const controls = buttons(content);
  const copies = controls.filter((button) => button.get_tooltip_text() === "Copy ticket ID");
  const stops = controls.filter((button) => button.has_css_class("ticket-stop"));
  expect(controls.filter((button) => button.has_css_class("ticket-open")).length).toBe(3);
  expect(copies.length).toBe(3);
  expect(stops.length).toBe(2);
  expect(content.measure(Gtk.Orientation.HORIZONTAL, -1)[0]).toBeLessThanOrEqual(320);
  expect(content.measure(Gtk.Orientation.VERTICAL, 320)[0]).toBeGreaterThan(0);
  const scroll = new Gtk.ScrolledWindow({ child: content, hscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true });
  const window = new Gtk.Window({ title: "Ticket card diagnostic", defaultWidth: 800, child: scroll });
  window.present();
  await settle();
  const grid = descendants(content).find((widget) => widget instanceof Gtk.FlowBox);
  const [first, second] = [grid?.get_child_at_index(0), grid?.get_child_at_index(1)];
  if (grid === undefined || !first || !second) throw new Error("Passengers are laid out in a flow box");
  const top = (child: Gtk.FlowBoxChild) => child.compute_bounds(grid)[1].get_y();
  expect(top(first)).toBe(top(second));
  window.set_focus(null);
  await settle();
  const tile = first.get_child();
  const focusWithin = () => ((tile?.get_state_flags() ?? 0) & Gtk.StateFlags.FOCUS_WITHIN) !== 0;
  expect(focusWithin()).toBe(false);
  controls.find((button) => button.has_css_class("ticket-open"))?.grab_focus();
  await settle();
  expect(focusWithin()).toBe(true);
  copies[0]?.emit("clicked");
  expect(await display.get_clipboard().read_text_async(null)).toBe("one");
  const departure = controls.find((button) => button.get_tooltip_text() === "Show Departure location");
  if (departure === undefined) throw new Error("Departure stop is a button");
  departure.emit("clicked");
  await settle();
  expect(labels(departure).some((text) => text.includes("Prague central bus station"))).toBe(true);
  const popover = departure.get_last_child();
  if (!(popover instanceof Gtk.Popover)) throw new Error("Departure details open in a popover");
  popover.popdown();
  await settle();
  window.set_default_size(320, 0);
  await settle();
  expect(top(second)).toBeGreaterThan(top(first));
  const timeline = departure.get_ancestor(Gtk.Grid.$gtype);
  if (!(timeline instanceof Gtk.Grid)) throw new Error("Stops are laid out in a grid");
  const connector = timeline.get_child_at(0, 1);
  expect(connector?.get_width()).toBeGreaterThanOrEqual(1);
  expect(connector?.get_width()).toBeLessThanOrEqual(3);
  expect(connector?.get_height()).toBeGreaterThanOrEqual(SMALL_SPACING);
  let previousBottom = 0;
  for (const stop of stops) {
    const [, bounds] = stop.compute_bounds(timeline);
    expect(bounds.get_x()).toBeGreaterThanOrEqual(0);
    expect(bounds.get_x() + bounds.get_width()).toBeLessThanOrEqual(timeline.get_width());
    expect(bounds.get_y() + bounds.get_height()).toBeLessThanOrEqual(timeline.get_height());
    expect(bounds.get_y()).toBeGreaterThanOrEqual(previousBottom);
    previousBottom = bounds.get_y() + bounds.get_height();
  }
  capture("BREVLADA_TICKET_SCREENSHOT", window, window);
  window.close();
});
