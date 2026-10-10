import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Parcel, Step } from "../models/parcel";
import { format, local, rfc3339, timestamp } from "../models/time";
import { card } from "./parcel";
import { buttons, capture, descendants, settle, useDisplay } from "./testing";

useDisplay();

const parcel = (steps: Step[]): Parcel => ({
  item: "Test package",
  arrivalFrom: null,
  arrivalUntil: null,
  carrier: null,
  trackingUrl: null,
  orderUrl: null,
  orderNumber: null,
  steps,
  details: { deliveryStatus: "In transit" },
});

const step = (name: string): Step => ({ name, date: null, location: null });

test("order dialog uses grouped selectable details and named links", async () => {
  const order: Parcel = {
    ...parcel([]),
    item: "USB-C charging hub",
    orderUrl: "https://example.com/orders/123",
    details: {
      "@type": "ParcelDelivery",
      carrier: { name: "Parcel Co" },
      trackingNumber: "XX12345678",
      deliveryStatus: "In transit",
      expectedArrivalUntil: "2026-10-03",
      trackingUrl: "https://example.com/track?token=long-opaque-token",
      partOfOrder: { orderNumber: "123", orderDate: "2026-09-29T12:30:00Z", url: "https://example.com/orders/123" },
      deliveryAddress: { streetAddress: "1 Main Street\nApartment 2", addressLocality: "London" },
    },
  };
  const time = rfc3339("2026-10-01T12:30:00Z");
  if (time === null) throw new Error("Valid timestamp");
  const sent = timestamp(time);
  const content = card(order, sent);
  const parent = new Gtk.Window({ child: content });
  buttons(content)
    .find((button) => descendants(button).some((label) => label instanceof Gtk.Label && label.get_text() === "Order Details"))
    ?.emit("clicked");
  await settle(200);
  const window = Gtk.Window.list_toplevels().find((toplevel) => toplevel instanceof Adw.Window && toplevel.get_title() === "Order Details");
  if (!(window instanceof Adw.Window)) throw new Error("Order dialog was presented");
  expect(window.get_modal()).toBe(true);
  expect(window.get_transient_for()).toBe(parent);
  const widgets = descendants(window);
  expect(widgets.filter((widget) => widget instanceof Adw.WindowTitle).every((title) => title.get_subtitle() === "")).toBe(true);
  const rows = widgets.filter((widget) => widget instanceof Adw.ActionRow);
  const row = (title: string) => rows.find((row) => row.get_title() === title);
  expect(row("Email date")?.get_subtitle()).toBe(format(local(sent), "%A, %-d %B %Y at %H:%M"));
  expect(row("Email date")?.get_subtitle_selectable()).toBe(true);
  expect(row("Order number")?.get_subtitle()).toBe("123");
  expect(row("Order number")?.get_subtitle_selectable()).toBe(true);
  expect(rows.every((row) => !row.get_use_markup() && !(row.get_subtitle() ?? "").includes("://"))).toBe(true);
  const links = widgets.filter((widget) => widget instanceof Gtk.Button).map((button) => button.get_label());
  expect(links).toContain("Track package");
  expect(links.filter((label) => label === "View order").length).toBe(1);
  capture("BREVLADA_ORDER_PREVIEW", window, window);
  window.close();
  parent.close();
});

test("timeline lines are thin", async () => {
  const content = card(parcel([step("Shipped"), step("Delivered")]), 0);
  const window = new Gtk.Window({ defaultWidth: 500, child: content });
  window.present();
  await settle(100);
  const line = descendants(content).find((widget) => widget.has_css_class("parcel-line"));
  expect(line?.get_height()).toBeGreaterThanOrEqual(1);
  expect(line?.get_height()).toBeLessThanOrEqual(3);
  capture("BREVLADA_PARCEL_PREVIEW", content, window);
  window.close();
});

test("single status and step use truck and normal text", () => {
  for (const steps of [[], [step("In transit")]]) {
    const widgets = descendants(card(parcel(steps), 0));
    expect(widgets.some((widget) => widget.has_css_class("parcel-single-step-name"))).toBe(true);
    expect(widgets.some((widget) => widget instanceof Gtk.Image && widget.get_icon_name() === "truck-symbolic")).toBe(true);
    expect(widgets.some((widget) => widget.has_css_class("dim-label"))).toBe(false);
  }
});
