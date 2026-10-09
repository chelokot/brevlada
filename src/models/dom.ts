import entities from "./entities.json";

export interface Element {
  name: string;
  attributes: [string, string][];
  children: Node[];
  parent: Element | null;
}

export type Node = Element | string;

const RAW = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const HEAD = new Set(["base", "basefont", "bgsound", "link", "meta", "title", "noscript", "noframes", "style", "script", "template"]);
const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const TABLE = new Set(["caption", "col", "colgroup", "frame", "tbody", "td", "tfoot", "th", "thead", "tr"]);
const NONE = new Set<string>();
const NAMED = new Map(Object.entries(entities));
const WINDOWS_1252 = new TextDecoder("windows-1252");
const BREAK = /(<(script|style|xmp|textarea|title|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\2|$)|<plaintext\b[\s\S]*|<!--[\s\S]*?(?:-->|$))|<\/br(?=[\s/>])[^>]*>/gi;
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*;?))|\r\n?/g;

function character(code: number) {
  if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252.decode(Uint8Array.of(code));
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
}

export function decode(value: string, attribute = false) {
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

let cached: { html: string; root: Element } | null = null;

export function parse(html: string): Element {
  if (cached && cached.html === html) return cached.root;
  const root: Element = { name: "", attributes: [], children: [], parent: null };
  const open: Element[] = [];
  const current = () => open.at(-1) ?? root;
  const opened = (name: string) => open.findLast((element) => element.name === name);
  const close = (element: Element | undefined) => {
    const index = element ? open.lastIndexOf(element) : -1;
    if (index >= 0) open.length = index;
  };
  let head: Element | undefined;
  let body = false;
  let comment = false;
  let text = "";
  const outside = () => current() === root || current() === head || current().name === "html";
  const start = () => {
    body = true;
    close(head);
  };
  const enter = (name: string, attributes: [string, string][], container: boolean) => {
    const parent = current();
    const element: Element = { name, attributes, children: [], parent };
    parent.children.push(element);
    if (container) open.push(element);
    return element;
  };
  new HTMLRewriter()
    .on("*", {
      element(tag) {
        const name = tag.tagName === "image" && !opened("svg") && !opened("math") ? "img" : tag.tagName;
        if (name === "head" && (head || body)) return;
        if (!body && outside() && name !== "html" && name !== "head" && !HEAD.has(name)) start();
        if (TABLE.has(name) && !opened("table")) return;
        if (!head && !body && HEAD.has(name)) head = enter("head", [], true);
        if (name === "a") close(opened("a"));
        const container = tag.canHaveContent && !VOID.has(name);
        const element = enter(name, [...tag.attributes], container);
        if (name === "head") head = element;
        if (container) tag.onEndTag(() => close(element));
      },
    })
    .onDocument({
      comments() {
        comment = true;
      },
      text(chunk) {
        text += chunk.text;
        if (!chunk.lastInTextNode || !text) return;
        if (!body && outside() && /\P{White_Space}/u.test(text)) start();
        const parent = current();
        const value = RAW.has(parent.name) ? text : decode(text);
        const last = parent.children.at(-1);
        if (typeof last === "string" && !comment) parent.children[parent.children.length - 1] = last + value;
        else parent.children.push(value);
        [text, comment] = ["", false];
      },
    })
    .transform(html.replace(BREAK, (match, raw?: string) => raw ?? "<br>"));
  cached = { html, root };
  return root;
}

export const attribute = (element: Element, name: string) => {
  const entry = element.attributes.find(([key]) => key === name);
  return entry ? decode(entry[1], true) : null;
};

export function* descendants(root: Element): Generator<Element> {
  const pending = [root];
  for (let element = pending.pop(); element; element = pending.pop()) {
    if (element !== root) yield element;
    for (const child of element.children.toReversed()) if (typeof child !== "string") pending.push(child);
  }
}

export function* ancestors(element: Element): Generator<Element> {
  for (let parent = element.parent; parent; parent = parent.parent) yield parent;
}

export function text(root: Element, skip = NONE, blocks = NONE, separator = "") {
  const parts: string[] = [];
  const pending: (Node | null)[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === null) parts.push(" ");
    else if (typeof node === "string") parts.push(node);
    else if (!skip.has(node.name)) {
      if (blocks.has(node.name)) {
        parts.push(" ");
        pending.push(null);
      }
      for (const child of node.children.toReversed()) pending.push(child);
    }
  }
  return parts.join(separator);
}

const escape = (value: string, attribute: boolean) => {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("\u00a0", "&nbsp;");
  return attribute ? escaped.replaceAll('"', "&quot;") : escaped.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
};

export function html(nodes: Node[], parent: string) {
  let result = "";
  const pending: (Node | { end: string })[] = nodes.toReversed();
  const owners = [parent];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (typeof node === "string") result += RAW.has(owners.at(-1) ?? parent) ? node : escape(node, false);
    else if ("end" in node) {
      result += `</${node.end}>`;
      owners.pop();
    } else {
      result += `<${node.name}${node.attributes.map(([key, value]) => ` ${key}="${escape(decode(value, true), true)}"`).join("")}>`;
      if (VOID.has(node.name)) continue;
      owners.push(node.name);
      pending.push({ end: node.name });
      for (const child of node.children.toReversed()) pending.push(child);
    }
  }
  return result;
}
