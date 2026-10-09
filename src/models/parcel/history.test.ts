import { expect, test } from "bun:test";
import { type Message, message as create } from "..";
import { type Parcel, parseMessage } from "../parcel";
import { isObject, type Json } from "../schema";
import { identifier, sequence } from "./history";

const message = (sender: string, order: string | null, status: string, timestamp: number) =>
  create({
    sender,
    timestamp,
    bodyLoaded: true,
    bodyHtml: `<script type='application/ld+json'>${JSON.stringify({ "@type": "ParcelDelivery", partOfOrder: { orderNumber: order }, deliveryStatus: status })}</script>`,
  });

const first = (item: Message): Parcel => {
  const [parcel] = parseMessage(item);
  if (!parcel) throw new Error("parcel expected");
  return parcel;
};

const untouched = function* (): Generator<Message> {
  throw new Error("Must not search without an identifier");
};

const names = (parcel: Parcel) => parcel.steps.map((step) => step.name);

const withTracking = (parcel: Parcel, trackingNumber: Json): Parcel => ({ ...parcel, details: { ...(isObject(parcel.details) ? parcel.details : {}), trackingNumber } });

test("combines ugreen tracking updates without inventing an order number", () => {
  const shipped = create({
    sender: "UGREEN <service.eu@ugreen.com>",
    subject: "Your order KVM Switch has already been shipped.",
    bodyHtml: "<div>Tracking number: CC996635912DE</div><div>Carrier: WINIT Carrier phone: What's inside</div>",
    timestamp: 1789965688,
    bodyLoaded: true,
  });
  const delivered = { ...shipped, subject: "Your order KVM Switch has been delivered.", timestamp: 1790303613 };
  const other = { ...delivered, bodyHtml: "<div>Tracking number: CC996635913DE</div>" };
  const differentSender = { ...delivered, sender: "other@example.com" };
  const parcel = first(delivered);
  expect(parcel.orderNumber).toBeNull();
  expect(identifier(parcel)).toEqual({ kind: "Tracking", value: "CC996635912DE" });
  const combined = sequence(parcel, delivered, [shipped, delivered, other, differentSender]);
  expect(combined.orderNumber).toBeNull();
  expect(names(combined)).toEqual(["In transit", "Delivered"]);
  const missing = withTracking(parcel, " ");
  expect(sequence(missing, delivered, untouched())).toEqual(missing);
});

test("order and tracking identifiers with the same value are distinct", () => {
  const order = message("shop@example.com", "123", "Sent", 100);
  const tracking = message("shop@example.com", null, "Delivered", 200);
  tracking.parcels = [withTracking(first(tracking), "123")];
  expect(sequence(first(order), order, [tracking]).steps.length).toBe(1);
});

test("combines separate emails in chronological order with email dates", () => {
  const sent = message("Shop <shop@example.com>", "123", "Sent", 100);
  const transit = message("SHOP@example.com", "123", "In transit", 200);
  const delivered = message("shop@example.com", "123", "Delivered", 300);
  const parcel = first(transit);
  const result = sequence(parcel, transit, [delivered, sent, transit, sent]);
  expect(names(result)).toEqual(["Sent", "In transit", "Delivered"]);
  expect(result.steps[0]?.date).toBe("1970-01-01T00:01:40+00:00");
  expect(result.details).toEqual(parcel.details);
});

test("isolates senders, orders and missing identifiers", () => {
  const source = message("shop@example.com", "123", "Sent", 100);
  const others = [message("shop@example.com", "1234", "Delivered", 200), message("other@example.com", "123", "Delivered", 200), message("shop@example.com", null, "Delivered", 200)];
  expect(sequence(first(source), source, others).steps.length).toBe(1);
  for (const id of [null, " "]) {
    const missing = message("shop@example.com", id, "Sent", 100);
    expect(sequence(first(missing), missing, untouched())).toEqual(first(missing));
  }
});

test("respects event dates and preserves distinct locations", () => {
  const source = message("shop@example.com", "123", "Sent", 300);
  source.bodyHtml = `<script type='application/ld+json'>${JSON.stringify({
    "@type": "ParcelDelivery",
    partOfOrder: { orderNumber: "123" },
    deliveryStatus: [
      { name: "Delivered", startDate: "2026-10-03" },
      { name: "In transit", startDate: "2026-10-02", location: "London" },
      { name: "In transit", startDate: "2026-10-01", location: "Paris" },
    ],
  })}</script>`;
  const result = sequence(first(source), source, [source]);
  expect(result.steps.length).toBe(3);
  expect(result.steps[0]?.location).toBe("Paris");
  expect(result.steps[2]?.name).toBe("Delivered");
});
