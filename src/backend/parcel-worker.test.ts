import { expect, test } from "bun:test";
import { message } from "../models";
import { matching } from "./parcel-worker";

test("matches tracking updates without an order number", () => {
  const update = (subject: string, tracking: string) =>
    message({ sender: "service.eu@ugreen.com", subject, bodyHtml: `<p>Tracking number: ${tracking}</p>`, bodyLoaded: true });
  const matches = matching(
    [
      update("Your order hub has already been shipped.", "CC996635912DE"),
      update("Your order hub has been delivered.", "CC996635912DE"),
      update("Your order hub has been delivered.", "CC996635912DE1"),
    ],
    "service.eu@ugreen.com",
    { kind: "Tracking", value: "CC996635912DE" },
  );
  expect(matches).toHaveLength(2);
  expect(matches.every((match) => match.parcels[0]?.orderNumber === null)).toBeTrue();
});

test("filters server substring matches to the exact sender and order", () => {
  const delivery = (sender: string, order: string) =>
    message({
      sender,
      bodyHtml: `<script type='application/ld+json'>{"@type":"ParcelDelivery","partOfOrder":{"orderNumber":"${order}"},"deliveryStatus":"Sent"}</script>`,
      bodyLoaded: true,
    });
  const matches = matching(
    [delivery("shop@example.com", "123"), delivery("shop@example.com", "1234"), delivery("other-shop@example.com", "123")],
    "shop@example.com",
    { kind: "Order", value: "123" },
  );
  expect(matches.map((match) => match.parcels[0]?.orderNumber)).toEqual(["123"]);
});
