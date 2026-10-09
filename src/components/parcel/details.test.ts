import { expect, test } from "bun:test";
import { fromTimestamp, timestamp } from "../../models/time";
import { dateInTimezone, fieldLabel, sections } from "./details";

test("dates use local time without shifting calendar-only dates", () => {
  const plusThree = (value: string) => dateInTimezone(value, (time) => fromTimestamp(timestamp(time), 3 * 3600));
  expect(plusThree("2026-09-30T23:30:00Z")).toBe("1 Oct 2026, 02:30");
  expect(plusThree("2026-09-30")).toBe("30 Sep 2026");
  expect(plusThree("Tomorrow")).toBe("Tomorrow");
});

test("groups order, items, address and updates with readable values", () => {
  const groups = sections({
    "@type": "ParcelDelivery",
    "@context": "https://schema.org",
    carrier: { "@type": "Organization", name: "Parcel Co" },
    trackingUrl: "https://example.com/track?token=abc",
    partOfOrder: { orderNumber: "123", orderStatus: "https://schema.org/OrderInTransit", url: "https://example.com/orders/123" },
    itemShipped: [{ name: "Shoes", sku: "SH-1" }],
    deliveryAddress: { streetAddress: "1 Main St\nApt 2", addressLocality: "London" },
    deliveryStatus: [{ name: "Shipped", startDate: "2026-09-30" }],
    empty: "",
    missing: null,
  });
  const [delivery] = groups;
  expect(delivery?.title).toBe("Delivery");
  expect(delivery?.rows[0]?.value).toBe("Parcel Co");
  expect(delivery?.rows[1]).toMatchObject({ value: "Track package", url: "https://example.com/track?token=abc" });
  const order = groups.find(({ title }) => title === "Order");
  expect(order?.rows.map(({ title, value, url }) => [title, value, url]).slice(0, 3)).toEqual([
    ["Order number", "123", null],
    ["Order status", "In transit", null],
    ["Website", "View order", "https://example.com/orders/123"],
  ]);
  expect(groups.map(({ title }) => title)).toEqual(expect.arrayContaining(["Item", "Delivery address", "Delivery update"]));
  for (const row of groups.flatMap(({ rows }) => rows)) {
    expect(row.title).not.toContain("·");
    expect(row.title.startsWith("@")).toBe(false);
    expect(row.value).not.toContain("://");
  }
});

test("handles acronyms, custom fields and missing details", () => {
  expect(["trackingURL", "custom_fieldName", "URLValue"].map(fieldLabel)).toEqual(["Tracking", "Custom field name", "URL value"]);
  expect(sections({ "@type": "ParcelDelivery", name: "", empty: [] })).toEqual([]);
  const values = sections({ requiresSignature: true, quantity: 2 })[0]?.rows.map(({ value }) => value);
  expect(values).toEqual(expect.arrayContaining(["Yes", "2"]));
});

test("tracking action links have a name and templates are omitted", () => {
  expect(sections({ potentialAction: { "@type": "TrackAction", target: { urlTemplate: "https://example.com/track" } } })[0]?.rows[0]?.value).toBe("Track package");
  expect(sections({ potentialAction: { target: { urlTemplate: "https://example.com/{trackingNumber}" } } })).toEqual([]);
});
