import type { Message } from "../models";
import { isReply } from "../models/calendar";
import { parse, text } from "../models/dom";
import { collapse, prefix } from "../models/text";

const SKIP = new Set(["head", "script", "style", "template"]);
const BLOCKS = new Set(
  "address article aside blockquote br div dl dt dd footer h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table td th tr ul".split(" "),
);

export function message(source: Message) {
  if (source.listPreview !== null) return source.listPreview;
  if (isReply(source)) return "";
  const content = collapse(source.bodyText.trim() ? prefix(source.bodyText, 4096) : text(parse(source.bodyHtml), SKIP, BLOCKS, "", 322));
  const characters = Array.from(content.slice(0, 322));
  return characters.length > 160 ? `${characters.slice(0, 160).join("").trimEnd()}…` : content;
}

export function thread(messages: Message[]) {
  const first = messages.find((source) => !isReply(source));
  return first ? message(first) : "";
}
