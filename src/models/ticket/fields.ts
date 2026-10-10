import GLib from "gi://GLib?version=2.0";
import { at, type Json, term } from "../schema";

export function kind(value: Json, name: string) {
  const type = at(value, "@type");
  return (Array.isArray(type) ? type : [type]).some((item) => typeof item === "string" && term(item) === name);
}

export function text(value: Json) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const named = (value: Json) => text(value) ?? text(at(value, "name"));

export function webUrl(value: string) {
  try {
    const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
    return ["http", "https"].includes(uri.get_scheme()) && Boolean(uri.get_host());
  } catch {
    return false;
  }
}

export function url(value: Json) {
  const link = text(value);
  return link !== null && webUrl(link) ? link : null;
}

export function place(value: Json) {
  const name = named(value);
  const code = text(at(value, "iataCode"));
  const parts = name === null ? (code === null ? [] : [code]) : [code === null || code === name ? name : `${name} (${code})`];
  const address = at(value, "address");
  const whole = text(address);
  if (whole !== null) parts.push(whole);
  else
    for (const key of ["streetAddress", "addressLocality", "addressCountry"]) {
      const part = named(at(address, key));
      if (part !== null && !parts.includes(part)) parts.push(part);
    }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function seat(value: Json) {
  const labels = [
    ["seatSection", "Section"],
    ["seatRow", "Row"],
    ["seatNumber", "Seat"],
  ];
  const parts = labels.flatMap(([key = "", label]) => {
    const part = text(at(value, key));
    return part === null ? [] : [`${label} ${part}`];
  });
  const type = text(at(value, "seatingType"));
  if (type !== null) parts.push(type);
  return parts.length > 0 ? parts.join(" · ") : null;
}
