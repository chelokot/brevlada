import type { Message } from ".";
import type { Result } from "../backend/protocol";
import { parse as dom, text } from "./dom";
import { collapse } from "./text";
import { format, local, parse } from "./time";

export const SOURCE_LABELS = ["Subject", "Sender (From)", "Reply-To", "Recipients (To)", "Cc", "Body"];

export interface Filters {
  sources: [boolean, boolean, boolean, boolean, boolean, boolean];
  from: string | null;
  to: string | null;
}

const DATE = "%Y-%m-%d";
const SKIP = new Set(["script", "style", "head", "template"]);
const BLOCKS = new Set(["p", "div", "br", "hr", "li", "tr", "td", "th", "section", "article", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "pre"]);

export const filters = (fields: Partial<Filters> = {}): Filters => ({ sources: [true, true, true, true, true, true], from: null, to: null, ...fields });

export function includesDate({ from, to }: Filters, timestamp: number) {
  if (from === null && to === null) return true;
  const date = format(local(timestamp), DATE);
  return (from === null || date >= from) && (to === null || date <= to);
}

export const matchesFields = ({ sources }: Filters, fields: string[], query: string) =>
  !query || fields.some((field, index) => sources[Math.min(index, 5)] && field.includes(query));

export function dates(from: string, to: string): Result<[from: string | null, to: string | null]> {
  const [start, end] = [from.trim(), to.trim()];
  const valid = (value: string) => {
    const date = parse(value, DATE);
    return !value || (date !== null && format(date, DATE) === value);
  };
  if (!valid(start) || !valid(end)) return { ok: false, error: "Use dates in YYYY-MM-DD format" };
  if (start && end && start > end) return { ok: false, error: "From must be on or before To" };
  return { ok: true, value: [start || null, end || null] };
}

export const htmlText = (html: string) => collapse(text(dom(html), SKIP, BLOCKS));

export const fields = (message: Message) => [
  message.subject,
  message.sender,
  message.replyTo,
  message.recipients,
  message.cc,
  message.bodyText,
  message.bodyHtml ? htmlText(message.bodyHtml) : "",
];
