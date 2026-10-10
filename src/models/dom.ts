import entities from "./entities.json";
import { collapse } from "./text";

export interface Element {
  name: string;
  attributes: [string, string][];
  source: string;
  children: Node[];
  parent: Element | null;
  empty: boolean;
}

export interface Document extends Element {
  elements: Element[];
}

export type Node = Element | string;

const RAW = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const RCDATA = new Set(["title", "textarea"]);
const HEAD = new Set(["base", "basefont", "bgsound", "link", "meta", "title", "noscript", "noframes", "style", "script", "template"]);
const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const TABLE = new Set(["caption", "col", "colgroup", "frame", "tbody", "td", "tfoot", "th", "thead", "tr"]);
const STRUCTURE = new Set(["table", "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "colgroup"]);
const SCOPE = new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"]);
const TABLE_SCOPE = new Set(["html", "table", "template"]);
const INTEGRATION = new Set(["svg", "math", "foreignobject", "desc"]);
const BREAKOUT = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var".split(" "),
);
const NONE = new Set<string>();
const NAMED = new Map(Object.entries(entities));
const WINDOWS_1252 = new TextDecoder("windows-1252");
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*;?))|\r\n?/g;
const closers = new Map<string, RegExp>();

function character(code: number) {
  if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252.decode(Uint8Array.of(code));
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
}

export function decode(value: string, attribute = false) {
  if (!value.includes("&") && !value.includes("\r")) return value;
  return value.replace(REFERENCE, (match, hex: string | undefined, decimal: string | undefined, name: string | undefined, offset: number) => {
    if (match.startsWith("\r")) return "\n";
    if (name === undefined) return character(hex === undefined ? Number(decimal) : parseInt(hex, 16));
    for (let length = name.length; length > 1; length--) {
      const replacement = NAMED.get(name.slice(0, length));
      if (replacement === undefined) continue;
      const rest = name.slice(length);
      const legacy = !name.slice(0, length).endsWith(";");
      return attribute && legacy && /^[=A-Za-z0-9]/.test(rest || value.charAt(offset + match.length)) ? match : replacement + rest;
    }
    return match;
  });
}

const space = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

const letter = (code: number) => (code >= 97 && code <= 122) || (code >= 65 && code <= 90);

const delimiter = (code: number) => code === 32 || code === 47 || code === 62 || code === 9 || code === 10 || code === 12 || code === 13;

function tag(html: string, start: number) {
  const attributes: [string, string][] = [];
  const length = html.length;
  let selfClosing = false;
  let position = start;
  while (position < length) {
    let code = html.charCodeAt(position);
    if (space(code)) position++;
    else if (code === 62) return { end: position + 1, attributes, selfClosing, source: html.slice(start, position) };
    else if (code === 47) selfClosing = html.charCodeAt(++position) === 62;
    else {
      const nameStart = position;
      do code = html.charCodeAt(++position);
      while (position < length && !delimiter(code) && code !== 61);
      const name = html.slice(nameStart, position).toLowerCase();
      while (space(code)) code = html.charCodeAt(++position);
      let value = "";
      if (code === 61) {
        do code = html.charCodeAt(++position);
        while (space(code));
        if (code === 34 || code === 39) {
          const close = html.indexOf(code === 34 ? '"' : "'", position + 1);
          if (close < 0) return null;
          value = html.slice(position + 1, close);
          position = close + 1;
        } else {
          const valueStart = position;
          while (position < length && !space(code) && code !== 62) code = html.charCodeAt(++position);
          value = html.slice(valueStart, position);
        }
      }
      attributes.push([name, value]);
      selfClosing = false;
    }
  }
  return null;
}

let cached: { html: string; root: Document } | null = null;

export function parse(html: string): Document {
  if (cached && cached.html === html) return cached.root;
  const root: Document = { name: "", attributes: [], source: "", children: [], parent: null, empty: false, elements: [] };
  const open: Element[] = [];
  const current = () => open.at(-1) ?? root;
  const opened = (name: string) => open.findLast((element) => element.name === name);
  let foreignSeen = false;
  const scope = () => open.findLast((element) => INTEGRATION.has(element.name));
  const foreign = () => {
    const element = foreignSeen ? scope() : undefined;
    return element !== undefined && (element.name === "svg" || element.name === "math");
  };
  const close = (element: Element | undefined) => {
    const index = element ? open.lastIndexOf(element) : -1;
    if (index >= 0) open.length = index;
  };
  let head: Element | undefined;
  let body = false;
  let comment = false;
  const outside = () => current() === root || current() === head || current().name === "html";
  const start = () => {
    body = true;
    close(head);
  };
  const enter = (name: string, attributes: [string, string][], source: string, empty: boolean) => {
    const parent = current();
    const element: Element = { name, attributes, source, children: [], parent, empty };
    parent.children.push(element);
    root.elements.push(element);
    if (!empty) open.push(element);
    return element;
  };
  const append = (value: string) => {
    if (!value) return;
    if (!body && outside() && /\P{White_Space}/u.test(value)) start();
    const parent = current();
    const last = parent.children.at(-1);
    if (typeof last === "string" && !comment) parent.children[parent.children.length - 1] = last + value;
    else parent.children.push(value);
    comment = false;
  };
  const opening = (raw: string, attributes: [string, string][], source: string, selfClosing: boolean) => {
    const breakout = (BREAKOUT.has(raw) || (raw === "font" && attributes.some(([key]) => key === "color" || key === "face" || key === "size"))) && foreign();
    if (breakout) close(scope());
    const name = raw === "image" && !foreign() ? "img" : raw;
    if (name === "head" && (head || body)) return null;
    if (!body && outside() && name !== "html" && name !== "head" && !HEAD.has(name)) start();
    if (TABLE.has(name) && !opened("table")) return null;
    if (!head && !body && HEAD.has(name)) head = enter("head", [], "", false);
    if (name === "a") close(opened("a"));
    const element = enter(name, attributes, source, VOID.has(name) || (selfClosing && foreign()));
    if (name === "head") head = element;
    foreignSeen ||= name === "svg" || name === "math";
    return element;
  };
  const ending = (name: string) => {
    if (name === "br") return opening("br", [], "", false);
    const boundaries = STRUCTURE.has(name) ? TABLE_SCOPE : SCOPE;
    const index = open.findLastIndex((element) => element.name === name || boundaries.has(element.name));
    const element = open[index];
    if (element && element.name === name) open.length = index;
    return null;
  };
  let index = 0;
  let textStart = 0;
  for (let lt = html.indexOf("<"); lt >= 0; lt = html.indexOf("<", index)) {
    const next = html.charCodeAt(lt + 1);
    const closing = next === 47 && letter(html.charCodeAt(lt + 2));
    const named = letter(next) || closing;
    if (!named && next !== 33 && next !== 63 && !(next === 47 && lt + 2 < html.length)) {
      index = lt + 1;
      continue;
    }
    append(html.slice(textStart, lt));
    if (named) {
      const nameStart = lt + (closing ? 2 : 1);
      let nameEnd = nameStart;
      while (nameEnd < html.length && !delimiter(html.charCodeAt(nameEnd))) nameEnd++;
      const found = tag(html, nameEnd);
      if (!found) {
        index = textStart = html.length;
        break;
      }
      index = found.end;
      const name = html.slice(nameStart, nameEnd).toLowerCase();
      const element = closing ? ending(name) : opening(name, found.attributes, found.source, found.selfClosing);
      if (element && !closing && (RAW.has(name) || RCDATA.has(name)) && !foreign()) {
        let closer = closers.get(name);
        if (!closer) closers.set(name, (closer = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi")));
        closer.lastIndex = index;
        const match = name === "plaintext" ? null : closer.exec(html);
        const end = match ? match.index : html.length;
        if (end > index) element.children.push(html.slice(index, end));
        index = end;
      }
    } else if (next === 33 && html.startsWith("!--", lt + 1)) {
      const end = html.startsWith(">", lt + 4) ? lt + 4 : html.startsWith("->", lt + 4) ? lt + 5 : html.indexOf("-->", lt + 4);
      index = end < 0 ? html.length : html.indexOf(">", end) + 1;
      comment = true;
    } else {
      const end = html.indexOf(">", lt + 2);
      index = end < 0 ? html.length : end + 1;
      comment = !(next === 47 && end === lt + 2);
    }
    textStart = index;
  }
  append(html.slice(textStart));
  cached = { html, root };
  return root;
}

export const attribute = (element: Element, name: string) => {
  const entry = element.attributes.find(([key]) => key === name);
  return entry ? decode(entry[1], true) : null;
};

export const descendants = (root: Document) => root.elements;

export function* ancestors(element: Element): Generator<Element> {
  for (let parent = element.parent; parent; parent = parent.parent) yield parent;
}

export function text(root: Element, skip = NONE, blocks = NONE, separator = "", limit = Infinity) {
  const parts: string[] = [];
  const frames = [{ element: root, index: 0 }];
  let size = 0;
  let check = limit;
  for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
    if (size >= check) {
      if (collapse(parts.join(separator)).length >= limit) break;
      check = size * 2;
    }
    const child = frame.element.children[frame.index++];
    if (child === undefined) {
      frames.pop();
      if (blocks.has(frame.element.name)) parts.push(" ");
    } else if (typeof child === "string") {
      const value = RAW.has(frame.element.name) ? child : decode(child);
      parts.push(value);
      size += value.length;
    }
    else if (!skip.has(child.name)) {
      if (blocks.has(child.name)) parts.push(" ");
      frames.push({ element: child, index: 0 });
    }
  }
  return parts.join(separator);
}

export function html(nodes: Node[]) {
  const parts: string[] = [];
  const frames = [{ nodes, index: 0, name: "" }];
  for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
    const node = frame.nodes[frame.index++];
    if (node === undefined) {
      frames.pop();
      if (frame.name) parts.push(`</${frame.name}>`);
    } else if (typeof node === "string") parts.push(node);
    else {
      parts.push(`<${node.name}${node.source}>`);
      if (!node.empty) frames.push({ nodes: node.children, index: 0, name: node.name });
    }
  }
  return parts.join("");
}
