import { event, type Event, sameEvent } from "../calendar";
import { parse as dom } from "../dom";
import { at, isObject, type Json, microdata, nested, scopes, scripts, term, values } from "../schema";
import { actions, add, webUrl } from "./rsvp";

const EXCLUDED = new Set(["EventReservation", "InviteAction", "RsvpAction"]);
const ADDRESS = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"];

export function parse(html: string): Event[] {
  if (!html.includes("Event")) return [];
  const root = dom(html);
  const events: Event[] = [];
  for (const value of scripts(root)) collect(value, events);
  for (const element of scopes(root)) if (!nested(element, (type) => EXCLUDED.has(type.slice(type.lastIndexOf("/") + 1)))) collect(microdata(element), events);
  return events;
}

const matches = (type: Json, name: string): boolean => (Array.isArray(type) ? type.some((item) => matches(item, name)) : typeof type === "string" && term(type) === name);

export const kind = (value: Json, name: string) => matches(at(value, "@type"), name);

export const text = (value: Json) => (typeof value === "string" && value.trim() ? value.trim() : null);

const named = (value: Json) => text(value) ?? text(at(value, "name"));

const link = (value: Json) => {
  const url = text(value);
  return url !== null && webUrl(url) ? url : null;
};

function location(value: Json): string | null {
  if (Array.isArray(value)) {
    const parts = value.map(location).filter((part) => part !== null);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const name = named(value);
  const address = isObject(value) && Object.hasOwn(value, "address") ? at(value, "address") : value;
  const whole = text(address);
  const parts = [name, ...(whole === null ? ADDRESS.map((key) => named(at(address, key))) : [whole])].filter((part) => part !== null);
  if (parts.length === 0) return link(at(value, "url"));
  return parts.filter((part, index) => part !== parts[index - 1]).join(", ");
}

function isEvent(type: Json) {
  if (typeof type === "string") {
    const name = term(type);
    return name.endsWith("Event") && name !== "DeliveryEvent";
  }
  return Array.isArray(type) && type.some((item) => typeof item === "string" && item.endsWith("Event") && !item.endsWith("DeliveryEvent"));
}

function collect(value: Json, events: Event[]) {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, events));
  if (!isObject(value)) return;
  const source = kind(value, "EventReservation")
    ? at(value, "reservationFor")
    : kind(value, "InviteAction") || kind(value, "RsvpAction")
      ? at(value, "event")
      : value;
  const [name, start] = [text(at(source, "name")), text(at(source, "startDate"))];
  if (!isEvent(at(source, "@type")) || name === null || start === null) return values(value).forEach((child) => collect(child, events));
  const found = event({
    uid: text(at(source, "@id")),
    name,
    start,
    end: text(at(source, "endDate")),
    location: location(at(source, "location")),
    organizer: named(at(source, "organizer")),
    description: text(at(source, "description")),
    url: link(at(source, "url")),
    status: text(at(source, "eventStatus")),
  });
  actions(at(source, "potentialAction"), found.rsvp);
  actions(at(source, "action"), found.rsvp);
  if (source !== value) actions(at(value, "potentialAction"), found.rsvp);
  if (kind(value, "RsvpAction")) actions(value, found.rsvp);
  const old = events.find((old) => sameEvent(old, found));
  if (old) for (const action of found.rsvp) add(old.rsvp, action);
  else events.push(found);
}
