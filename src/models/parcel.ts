import type { Message } from ".";
import { attribute, descendants, parse as dom, text } from "./dom";
import { at, isObject, type Json, microdata, scopes, scripts, values } from "./schema";
import { key } from "./senders";
import { asciiLower } from "./text";

export { identifier, type Identifier, orderId, sequence } from "./parcel/history";

export interface Step {
  name: string | null;
  date: string | null;
  location: string | null;
}

export interface Parcel {
  item: string | null;
  arrivalFrom: string | null;
  arrivalUntil: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  orderUrl: string | null;
  orderNumber: string | null;
  steps: Step[];
  details: Json;
}

const TRACKING = /Tracking number:\p{White_Space}*([A-Za-z0-9-]{6,40})/iu;
const CARRIER = /Carrier:\p{White_Space}*([A-Za-z0-9 -]{2,40}?)\p{White_Space}+(?:Carrier phone|What's inside)/iu;
const ITEM = /^Your order (.+?) has (?:already been shipped|been delivered)/iu;
const ORDER = /(?<![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}])Order\p{White_Space}*(?:number|id|#)\p{White_Space}*:?\p{White_Space}*#?\p{White_Space}*([A-Za-z0-9][A-Za-z0-9-]*)/iu;
const STEPS = new Map([
  ["http://schema.org/Delivered", "Delivered"],
  ["https://schema.org/Delivered", "Delivered"],
  ["http://schema.org/InTransit", "In transit"],
  ["https://schema.org/InTransit", "In transit"],
]);

export function parse(html: string): Parcel[] {
  const root = dom(html);
  const parcels: Parcel[] = [];
  for (const value of scripts(root)) collect(value, parcels);
  for (const element of scopes(root)) if ((attribute(element, "itemtype") ?? "").endsWith("ParcelDelivery")) parcels.push(fromValue(microdata(element)));
  return parcels;
}

export function parseMessage(message: Message): Parcel[] {
  const ugreen = key(message) === "service.eu@ugreen.com";
  const structured = message.bodyHtml.includes("ParcelDelivery") ? parse(message.bodyHtml) : [];
  if (structured.length > 0 || !ugreen) return structured;
  const root = dom(message.bodyHtml);
  const content = text(root, undefined, undefined, " ");
  const tracking = TRACKING.exec(content);
  if (!tracking) return [];
  const [, trackingNumber = ""] = tracking;
  const [, carrier = null] = CARRIER.exec(content) ?? [];
  const [, item = null] = ITEM.exec(message.subject) ?? [];
  const [, orderNumber = null] = ORDER.exec(content) ?? ORDER.exec(message.subject) ?? [];
  const link = [...descendants(root)].find((element) => {
    const href = attribute(element, "href");
    return element.name === "a" && href !== null && asciiLower(text(element)).includes("track your order") && href.startsWith("https://");
  });
  const trackingUrl = link ? attribute(link, "href") : null;
  const details: Json = {
    ...(orderNumber === null ? {} : { partOfOrder: { orderNumber } }),
    trackingNumber,
    ...(item === null ? {} : { itemShipped: item }),
    ...(carrier === null ? {} : { carrier: carrier.trim() }),
    ...(trackingUrl === null ? {} : { trackingUrl }),
    deliveryStatus: asciiLower(message.subject).includes("delivered") ? "Delivered" : "In transit",
  };
  return [
    { item, arrivalFrom: null, arrivalUntil: null, carrier: carrier && carrier.trim(), trackingUrl, orderUrl: null, orderNumber, steps: [], details },
  ];
}

function collect(value: Json, parcels: Parcel[]) {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, parcels));
  if (!isObject(value)) return;
  const type = at(value, "@type");
  const parcel = (Array.isArray(type) ? type : [type]).some((kind) => typeof kind === "string" && kind.endsWith("ParcelDelivery"));
  if (parcel) parcels.push(fromValue(value));
  else values(value).forEach((child) => collect(child, parcels));
}

function field(value: Json, key: string) {
  const item = at(value, key);
  return typeof item === "string" && item ? item : null;
}

const name = (value: Json) => (typeof value === "string" ? value : (field(value, "name") ?? field(value, "addressLocality")));

function fromValue(value: Json): Parcel {
  const order = at(value, "partOfOrder");
  const items = at(value, "itemShipped");
  const names = Array.isArray(items) ? items.map(name).filter((item) => item !== null) : [];
  const statuses = at(value, "deliveryStatus");
  const events = Array.isArray(statuses) ? statuses : isObject(statuses) || typeof statuses === "string" ? [statuses] : [];
  const steps = events
    .map((event) => {
      const label = name(event);
      return {
        name: label === null ? null : (STEPS.get(label) ?? label),
        date: field(event, "startDate") ?? field(event, "availableFrom"),
        location: name(at(event, "location")),
      };
    })
    .filter((step) => step.name !== null || step.date !== null || step.location !== null);
  const action = at(value, "potentialAction");
  return {
    item: Array.isArray(items) ? (names.length > 0 ? names.join(", ") : null) : name(items),
    arrivalFrom: field(value, "expectedArrivalFrom"),
    arrivalUntil: field(value, "expectedArrivalUntil") ?? field(value, "expectedArrival"),
    carrier: name(at(value, "carrier")) ?? name(at(value, "provider")),
    trackingUrl: field(value, "trackingUrl") ?? field(action, "url") ?? field(action, "target") ?? field(at(action, "target"), "urlTemplate"),
    orderUrl: field(order, "url"),
    orderNumber: field(order, "orderNumber") ?? field(value, "orderNumber"),
    steps,
    details: value,
  };
}
