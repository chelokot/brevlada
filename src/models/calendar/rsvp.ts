import type { Rsvp } from "../calendar";
import { at, isObject, type Json } from "../schema";
import { sameAscii } from "../text";
import { kind, text } from "./schema";

const LABELS = new Map([
  ["RsvpResponseYes", "Yes"],
  ["Yes", "Yes"],
  ["RsvpResponseNo", "No"],
  ["No", "No"],
  ["RsvpResponseMaybe", "Maybe"],
  ["Maybe", "Maybe"],
]);

export const webUrl = (url: string) => (url.startsWith("https://") || url.startsWith("http://")) && !/[\r\n{}]/.test(url);

const link = (value: string | null) => (value !== null && webUrl(value) ? value : null);

const last = (value: string) => value.slice(value.lastIndexOf("/") + 1);

export function add(rsvp: Rsvp[], action: Rsvp) {
  if (!rsvp.some(({ label, url }) => label === action.label && url === action.url)) rsvp.push(action);
}

function target(value: Json) {
  const method = text(at(value, "httpMethod")) ?? text(at(value, "method"));
  if (method !== null && !sameAscii(last(method), "GET")) return null;
  return link(text(value) ?? text(at(value, "urlTemplate")) ?? text(at(value, "url")));
}

export function actions(value: Json, rsvp: Rsvp[]) {
  if (Array.isArray(value)) return value.forEach((item) => actions(item, rsvp));
  if (!isObject(value) || !kind(value, "RsvpAction")) return;
  const key = ["target", "handler"].find((name) => Object.hasOwn(value, name));
  const handler = key === undefined ? null : at(value, key);
  const targets = Array.isArray(handler) ? handler : [handler];
  const url = targets.map(target).find((url) => url !== null) ?? (handler === null ? link(text(at(value, "url"))) : null);
  if (url === null) return;
  const response = text(at(value, "rsvpResponse")) ?? text(at(value, "attendance"));
  add(rsvp, { label: (response === null ? undefined : LABELS.get(last(response))) ?? text(at(value, "name")) ?? "RSVP", url });
}
