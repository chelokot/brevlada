import { ancestors, attribute, descendants, text, type Element } from "./dom";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isObject = (value: Json): value is { [key: string]: Json } => typeof value === "object" && value !== null && !Array.isArray(value);

export const at = (value: Json, key: string): Json => (isObject(value) ? (value[key] ?? null) : null);

export const values = (value: { [key: string]: Json }) =>
  Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, item]) => item);

export function json(source: string): Json {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

export const scripts = (root: Element) =>
  descendants(root)
    .filter((element) => element.name === "script" && attribute(element, "type") === "application/ld+json")
    .map((script) => json(text(script)))
    .toArray();

export const scopes = (root: Element) => descendants(root).filter((element) => attribute(element, "itemscope") !== null && attribute(element, "itemtype") !== null);

export const term = (value: string) => value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf(":"), value.lastIndexOf("#")) + 1);

export const nested = (element: Element, matches: (type: string) => boolean) =>
  ancestors(element).some((parent) => (attribute(parent, "itemtype") ?? "").split(/\p{White_Space}+/u).some(matches));

export function microdata(element: Element): Json {
  const entries = new Map<string, Json>();
  const type = attribute(element, "itemtype");
  if (type !== null) entries.set("@type", type.slice(type.lastIndexOf("/") + 1));
  const pending = element.children.toReversed();
  for (let child = pending.pop(); child !== undefined; child = pending.pop()) {
    if (typeof child === "string") continue;
    const scope = attribute(child, "itemscope") !== null;
    const property = attribute(child, "itemprop");
    if (property !== null) {
      const value = scope ? microdata(child) : (["content", "href", "src", "datetime"].map((name) => attribute(child, name)).find((value) => value !== null) ?? text(child).trim());
      const previous = entries.get(property);
      if (Array.isArray(previous)) previous.push(value);
      else entries.set(property, previous === undefined ? value : [previous, value]);
    }
    if (!scope) for (const node of child.children.toReversed()) pending.push(node);
  }
  return Object.fromEntries(entries);
}
