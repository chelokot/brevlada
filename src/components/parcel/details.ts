import { at, isObject, type Json } from "../../models/schema";
import { collapse } from "../../models/text";
import { format, local, parse, rfc3339, type Time, timestamp } from "../../models/time";

export interface Section {
  title: string;
  rows: Detail[];
}

export interface Detail {
  title: string;
  value: string;
  url: string | null;
}

const ADDRESS = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"];
const SCHEMA = ["https://schema.org/", "http://schema.org/"];
const UPPERCASE = /\p{Uppercase}/u;
const LOWERCASE = /\p{Lowercase}/u;
const SEPARATOR = /^[_\-\p{White_Space}]$/u;

const LABELS = new Map(
  Object.entries({
    itemShipped: "Item",
    partOfOrder: "Order",
    deliveryStatus: "Status",
    expectedArrivalFrom: "Arriving from",
    expectedArrivalUntil: "Arriving by",
    expectedArrival: "Expected delivery",
    deliveryAddress: "Delivery address",
    shippingAddress: "Shipping address",
    billingAddress: "Billing address",
    addressLocality: "City",
    addressRegion: "Region",
    addressCountry: "Country",
    streetAddress: "Street address",
    postalCode: "Postal code",
    orderDate: "Ordered on",
    orderStatus: "Order status",
    startDate: "Date",
    availableFrom: "Date",
    endDate: "Until",
    availableThrough: "Until",
    trackingUrl: "Tracking",
    trackingURL: "Tracking",
    url: "Website",
    URL: "Website",
    urlTemplate: "Website",
    potentialAction: "Tracking",
    target: "Link",
    sku: "SKU",
    gtin: "Barcode",
    priceCurrency: "Currency",
    telephone: "Phone",
  }),
);

const RANKS = new Map(
  Object.entries({
    name: 0,
    orderNumber: 1,
    trackingNumber: 1,
    deliveryStatus: 2,
    orderStatus: 2,
    orderDate: 3,
    expectedArrivalFrom: 3,
    startDate: 3,
    expectedArrivalUntil: 4,
    expectedArrival: 4,
    endDate: 4,
    partOfOrder: 6,
    itemShipped: 7,
    deliveryAddress: 8,
    potentialAction: 9,
  }),
);

export const web = (url: string) => url.startsWith("https://") || url.startsWith("http://");

export function address(value: Json) {
  const text = (value: Json) => {
    const found = isObject(value) ? at(value, "name") : value;
    return typeof found === "string" ? collapse(found) || null : null;
  };
  if (typeof value === "string") return text(value);
  const parts = ADDRESS.map((key) => text(at(value, key))).filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

export const date = (value: string) => dateInTimezone(value, (time) => local(timestamp(time)));

export function dateInTimezone(value: string, zone: (time: Time) => Time) {
  const time = rfc3339(value);
  if (time !== null) return format(zone(time), "%-d %b %Y, %H:%M");
  const day = parse(value, "%Y-%m-%d");
  return day === null ? value : format(day, "%-d %b %Y");
}

function words(value: string) {
  const characters = Array.from(value);
  let words = "";
  characters.forEach((character, index) => {
    if (SEPARATOR.test(character)) {
      if (words && !words.endsWith(" ")) words += " ";
      return;
    }
    const previous = characters[index - 1];
    const next = characters[index + 1];
    const boundary = previous !== undefined && (LOWERCASE.test(previous) || (UPPERCASE.test(previous) && next !== undefined && LOWERCASE.test(next)));
    if (UPPERCASE.test(character) && boundary && !words.endsWith(" ")) words += " ";
    words += character;
  });
  const [first, ...rest] = Array.from(
    collapse(words)
      .split(" ")
      .map((word) => (LOWERCASE.test(word) ? word.toLowerCase() : word))
      .join(" "),
  );
  return first === undefined ? "" : first.toUpperCase() + rest.join("");
}

export const fieldLabel = (key: string) => LABELS.get(key) ?? words(key);

const within = (section: string, name: string) => section === name || section.startsWith(`${name} `);

function detail(key: string, value: Json, section: string): Detail | null {
  const text = typeof value === "string" ? value.trim() : typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "number" ? String(value) : "";
  if (!text) return null;
  const row: Detail = { title: fieldLabel(key), value: date(text), url: null };
  const schema = SCHEMA.find((prefix) => text.startsWith(prefix));
  if (schema !== undefined) {
    const term = text.slice(schema.length);
    row.value = words(term.startsWith("Order") ? term.slice("Order".length) : term);
  } else if (web(text)) {
    if (text.includes("{") || text.includes("}")) return null;
    row.value =
      key === "image"
        ? "View image"
        : key === "trackingUrl" || key === "trackingURL" || within(section, "Tracking")
          ? "Track package"
          : within(section, "Order")
            ? "View order"
            : within(section, "Item")
              ? "View item"
              : "Open website";
    row.url = text;
  }
  return row;
}

export function sections(value: Json) {
  const output: Section[] = [];
  collect(value, "Delivery", output);
  return output;
}

function collect(value: Json, title: string, output: Section[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const heading = value.length === 1 ? title : `${title} ${index + 1}`;
      if (typeof item === "object" && item !== null) return collect(item, heading, output);
      const row = detail(title, item, title);
      if (row) output.push({ title: heading, rows: [row] });
    });
    return;
  }
  if (!isObject(value)) return;
  const section: Section = { title, rows: [] };
  const children: [string, Json][] = [];
  const fields = Object.keys(value)
    .filter((key) => !key.startsWith("@"))
    .sort()
    .sort((left, right) => (RANKS.get(left) ?? 5) - (RANKS.get(right) ?? 5));
  for (const key of fields) {
    const child = at(value, key);
    const named = isObject(child) && Object.keys(child).filter((name) => !name.startsWith("@")).length === 1 ? at(child, "name") : child;
    const row = detail(key, named, title);
    if (row) section.rows.push(row);
    else if (typeof child === "object" && child !== null) children.push([key, child]);
  }
  if (section.rows.length > 0) output.push(section);
  for (const [key, child] of children) collect(child, key === "target" ? title : key === "deliveryStatus" ? "Delivery update" : fieldLabel(key), output);
}
