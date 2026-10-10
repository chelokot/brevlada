import { expect, test } from "bun:test";
import { message } from ".";
import { parse, parseMessage } from "./parcel";

test("recognizes single status and explicit order id", () => {
  const [parcel] = parse(`<script type="application/ld+json">{"@type":"ParcelDelivery","orderNumber":"123","deliveryStatus":"https://schema.org/Delivered"}</script>`);
  expect(parcel?.orderNumber).toBe("123");
  expect(parcel?.steps[0]?.name).toBe("Delivered");
});

test("uses explicit ugreen order number without using tracking as order id", () => {
  const item = message({
    sender: "service.eu@ugreen.com",
    subject: "Your order USB hub has been delivered.",
    bodyHtml: "<p>Order number: #EU-123 Tracking number: XX12345678</p>",
    bodyLoaded: true,
  });
  expect(parseMessage(item)[0]?.orderNumber).toBe("EU-123");
  expect(parseMessage({ ...item, bodyHtml: "<p>Tracking number: XX12345678</p>" })[0]?.orderNumber).toBeNull();
});

test("extracts parcel and timeline from json-ld graph", () => {
  const parcels = parse(
    `<script type="application/ld+json">{"@graph":[{"@type":"ParcelDelivery","itemShipped":{"name":"Shoes"},"carrier":{"name":"Parcel Co"},"potentialAction":{"@type":"TrackAction","url":"https://example.org/track"},"deliveryStatus":[{"@type":"DeliveryEvent","name":"Shipped","startDate":"2026-09-29","location":"London"}]}]}</script>`,
  );
  expect(parcels.length).toBe(1);
  expect(parcels[0]).toMatchObject({ item: "Shoes", trackingUrl: "https://example.org/track" });
  expect(parcels[0]?.steps[0]?.location).toBe("London");
});

test("extracts microdata without mixing nested names", () => {
  const parcels = parse(
    `<div itemscope itemtype="https://schema.org/ParcelDelivery"><div itemprop="carrier" itemscope itemtype="https://schema.org/Organization"><meta itemprop="name" content="Courier" /></div><div itemprop="itemShipped" itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="Shoes" /></div><link itemprop="trackingUrl" href="https://example.org/track" /></div>`,
  );
  expect(parcels.length).toBe(1);
  expect(parcels[0]).toMatchObject({ carrier: "Courier", item: "Shoes", trackingUrl: "https://example.org/track" });
});

test("recognizes ugreen shipping email without structured markup", () => {
  const parcels = parseMessage(
    message({
      sender: "UGREEN <service.eu@ugreen.com>",
      subject: "Your order USB hub has already been shipped.",
      bodyHtml: "<p>Tracking number: XX12345678 Carrier: WINIT Carrier phone: What's inside</p><a href='https://example.org/track'>Track your order</a>",
      bodyLoaded: true,
    }),
  );
  expect(parcels.length).toBe(1);
  expect(parcels[0]).toMatchObject({ item: "USB hub", carrier: "WINIT", steps: [], details: { deliveryStatus: "In transit" }, trackingUrl: "https://example.org/track" });
});

test("ugreen text keeps text nodes apart like html5ever", () => {
  const [parcel] = parseMessage(
    message({
      sender: "service.eu@ugreen.com",
      subject: "Your order Hub has been delivered.",
      bodyHtml: "<b>Tracking number:</b>XX12345678<i>Carrier:</i><i>DHL</i><i>What's inside</i>",
    }),
  );
  expect(parcel).toMatchObject({ carrier: "DHL", details: { trackingNumber: "XX12345678", deliveryStatus: "Delivered", itemShipped: "Hub" } });
});
