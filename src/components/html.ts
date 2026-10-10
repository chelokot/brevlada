import type { Message } from "../models";
import { ancestors, attribute, decode, descendants, html, type Node, parse } from "../models/dom";
import { asciiLower, lines } from "../models/text";
import css from "./html_viewer/body.css" with { type: "text" };

const MEDIA = new Map([
  ["img", ["src", "srcset"]],
  ["source", ["srcset"]],
  ["video", ["poster"]],
]);
const REMOTE = ["https://", "http://", "//", "cid:"];
const CID = /cid:([^\p{White_Space}"'<>)]+)/giu;
const BODY = new Set(["style", "class", "id", "dir", "lang"]);
const MARKUP = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ["'", "&#39;"],
  ['"', "&quot;"],
]);

const escape = (text: string) =>
  text.replace(/[&<>'"\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f]/g, (char) => MARKUP.get(char) ?? `&#x${char.charCodeAt(0).toString(16)};`);

const remote = (value: string | null) => value !== null && value.split(",").some((candidate) => REMOTE.some((start) => candidate.trimStart().startsWith(start)));

export function hasRemoteMedia(message: Message) {
  if (message.remoteMedia !== null) return message.remoteMedia;
  if (!message.bodyLoaded || !message.bodyHtml) return false;
  return descendants(parse(message.bodyHtml)).some(
    (element) =>
      (MEDIA.get(element.name) ?? []).some((name) => attribute(element, name) !== null) &&
      ["src", "srcset", "poster"].some((name) => remote(attribute(element, name))),
  );
}

export function document(message: Message, hideQuotes: boolean, media: boolean) {
  const plain = !message.bodyHtml;
  const content = plain ? plainText(message.bodyText, hideQuotes) : normalizedHtml(message.bodyHtml);
  const body =
    media && message.inlineMedia.length > 0
      ? content.replace(CID, (match, id: string) => {
          const part = message.inlineMedia.find((part) => part.contentId === asciiLower(id));
          return part ? `data:${part.mime};base64,${part.data}` : match;
        })
      : content;
  return `<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:;"></head><body><div id='brevlada-content' data-plain-text='${plain}' data-hide-quotes='${hideQuotes}'>${body}</div><style>${css}</style></body></html>`;
}

const content = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) => (typeof node === "string" ? [node] : node.name === "head" ? [] : node.name === "html" || node.name === "body" ? content(node.children) : [node]));

function normalizedHtml(source: string) {
  const root = parse(source);
  const styles = descendants(root).filter((element) => element.name === "style" && ancestors(element).some((parent) => parent.name === "head"));
  const body = descendants(root).find((element) => element.name === "body");
  const attributes = body ? body.attributes.filter(([name]) => BODY.has(name)).map(([name, value]) => ` ${name}="${escape(decode(value, true))}"`) : [];
  return `${html(styles)}<div${attributes.join("")}>${html(content(root.children))}</div>`;
}

export function plainText(text: string, hideQuotes: boolean) {
  const all = lines(text);
  const blank = (line: string) => !line.trim();
  const end = all.findLastIndex((line) => !blank(line));
  const last = all.findLast((line) => !blank(line));
  const start = last !== undefined && last.trimStart().startsWith(">") ? all.findLastIndex((line) => !blank(line) && !line.trimStart().startsWith(">")) + 1 : -1;
  if (start < 0) return `<pre>${all.slice(0, end + 1).map(escape).join("\n")}</pre>`;
  if (!hideQuotes) {
    const [reply, quote] = [all.slice(0, start), all.slice(start, end + 1)].map((part) => part.map(escape).join("\n"));
    return `<pre>${reply}</pre><details><summary>Quoted reply</summary><pre>${quote}</pre></details>`;
  }
  const before = all.slice(0, start);
  const attribution = before.findLast((line) => !blank(line));
  const hidden = before.findLastIndex((line) => !blank(line)) + 1 - (attribution !== undefined && attribution.trimEnd().endsWith("wrote:") ? 1 : 0);
  return `<pre>${before.slice(0, hidden).map(escape).join("\n")}</pre>`;
}
