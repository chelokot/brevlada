import { TextDecoder } from "node:util";
import { asciiLower } from "../models/text";

const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const COLON = 58;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const utf16 = new TextDecoder("utf-16be", { ignoreBOM: true });
const windows1252 = new TextDecoder("windows-1252");

type Decoder = { decode(bytes: Uint8Array): string };
const decoders = new Map<string, Decoder | null>();
const replacement = new Set(["csiso2022kr", "hz-gb-2312", "iso-2022-cn", "iso-2022-cn-ext", "iso-2022-kr", "replacement"]);
const utf7Labels = new Set(["utf-7", "csunicode11utf7", "unicode-1-1-utf-7", "x-unicode-2-0-utf-7"]);
const extended: Record<string, string> = {
  ms950: "big5",
  ms950_hkscs: "big5",
  "x-windows-950": "big5",
  ms874: "windows-874",
  tis620: "windows-874",
  "x-windows-874": "windows-874",
  ms936: "gb18030",
  euc_cn: "gb18030",
  ms949: "euc-kr",
  euc_kr: "euc-kr",
  "x-windows-949": "euc-kr",
  euc_jp: "euc-jp",
  koi8_r: "koi8-r",
  koi8_u: "koi8-u",
  iso8859_1: "windows-1252",
  iso8859_2: "iso-8859-2",
  iso8859_3: "iso-8859-3",
  iso8859_4: "iso-8859-4",
  iso8859_5: "iso-8859-5",
  iso8859_6: "iso-8859-6",
  iso8859_7: "iso-8859-7",
  iso8859_9: "windows-1254",
  iso8859_13: "iso-8859-13",
  iso8859_15: "iso-8859-15",
  iso2022jp: "iso-2022-jp",
};

const space = /\p{White_Space}/u;
const trimStart = (text: string) => text.replace(/^\p{White_Space}+/u, "");
const trimEnd = (text: string) => {
  let end = text.length;
  while (end && space.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
};
export const trim = (text: string) => trimEnd(trimStart(text));

export interface Header {
  key: string;
  value: Uint8Array;
}

export interface ContentType {
  mimetype: string;
  charset: string;
  params: Map<string, string>;
}

export interface Disposition {
  type: string;
  params: Map<string, string>;
}

export class Part {
  constructor(
    readonly headers: Header[],
    readonly ctype: ContentType,
    readonly content: Uint8Array,
    readonly subparts: Part[],
  ) {}

  header(name: string): string | null {
    const lower = name.toLowerCase();
    const found = this.headers.find(({ key }) => key.length === lower.length && key.toLowerCase() === lower);
    return found ? headerValue(found.value) : null;
  }

  disposition(): Disposition {
    const value = this.header("Content-Disposition");
    if (value === null) return { type: "inline", params: new Map() };
    const { value: type, params } = parameters(value);
    return { type: type.toLowerCase(), params };
  }

  bodyRaw(): Uint8Array {
    const encoding = this.header("Content-Transfer-Encoding");
    switch (encoding && encoding.toLowerCase()) {
      case "base64":
        return base64(windows1252.decode(this.content));
      case "quoted-printable":
        return quotedPrintable(windows1252.decode(this.content));
      default:
        return this.content;
    }
  }

  body(): string {
    const bytes = this.bodyRaw();
    const decoder = decoderFor(this.ctype.charset, true);
    if (!decoder) return latin1(bytes).replace(/[^\0-\x7f]/g, "\ufffd");
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
    return (bom ? new TextDecoder(bom) : decoder).decode(bytes);
  }
}

export const parseMail = (bytes: Uint8Array) => parsePart(bytes, false);

function parsePart(bytes: Uint8Array, digest: boolean): Part {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Header[] = [];
  let index = 0;
  while (index < buffer.length) {
    if (buffer[index] === LF) {
      index++;
      break;
    }
    if (buffer[index] === CR) {
      if (buffer[index + 1] !== LF) throw new Error("Headers were followed by an unexpected lone CR character!");
      index += 2;
      break;
    }
    if (buffer[index] === SPACE) throw new Error("Header cannot start with a space; it is likely an overhanging line from a previous header");
    index = parseHeader(buffer, index, headers);
  }
  const contentType = headers.find(({ key }) => key.length === 12 && key.toLowerCase() === "content-type");
  const ctype = contentType ? parseContentType(headerValue(contentType.value)) : { mimetype: digest ? "message/rfc822" : "text/plain", charset: "us-ascii", params: new Map() };
  const boundaryValue = ctype.params.get("boundary");
  const subparts: Part[] = [];
  let content = buffer.subarray(index);
  if (ctype.mimetype.startsWith("multipart/") && boundaryValue !== undefined && buffer.length > index) {
    const boundary = Buffer.from(`--${boundaryValue}`);
    const first = linePrefix(buffer, index, boundary);
    if (first >= 0) {
      content = buffer.subarray(index, trimNewline(buffer, index, first));
      for (let end = first + boundary.length, start = buffer.indexOf(LF, end) + 1; start > 0; start = buffer.indexOf(LF, end) + 1) {
        const next = linePrefix(buffer, start, boundary);
        subparts.push(parsePart(buffer.subarray(start, next >= 0 ? trimNewline(buffer, start, next) : buffer.length), ctype.mimetype === "multipart/digest"));
        end = next >= 0 ? next + boundary.length : buffer.length;
        if (end + 2 > buffer.length || (buffer[end] === 45 && buffer[end + 1] === 45)) break;
      }
    }
  }
  return new Part(headers, ctype, content, subparts);
}

function parseHeader(buffer: Buffer, start: number, headers: Header[]) {
  let index = start;
  while (index < buffer.length && buffer[index] !== COLON && buffer[index] !== LF) index++;
  const key = latin1(buffer.subarray(start, index));
  if (index >= buffer.length || buffer[index] === LF) {
    headers.push({ key, value: buffer.subarray(index, index) });
    return Math.min(index + 1, buffer.length);
  }
  index++;
  while (buffer[index] === SPACE) index++;
  const valueStart = index;
  let valueEnd = index;
  for (;;) {
    const newline = buffer.indexOf(LF, index);
    const lineEnd = newline < 0 ? buffer.length : newline;
    let last = lineEnd;
    while (last > index && buffer[last - 1] === CR) last--;
    if (last > index) valueEnd = last;
    if (newline < 0 || (buffer[newline + 1] !== SPACE && buffer[newline + 1] !== TAB)) {
      headers.push({ key, value: buffer.subarray(valueStart, valueEnd) });
      return newline < 0 ? buffer.length : newline + 1;
    }
    index = newline + 1;
  }
}

function linePrefix(buffer: Buffer, start: number, key: Buffer) {
  for (let index = buffer.indexOf(key, start); index >= 0; index = buffer.indexOf(key, index + 1)) {
    if (index === start || buffer[index - 1] === LF) return index;
  }
  return -1;
}

function trimNewline(buffer: Buffer, start: number, end: number) {
  if (end <= start || buffer[end - 1] !== LF) return end;
  return end - 1 > start && buffer[end - 2] === CR ? end - 2 : end - 1;
}

export function headerValue(bytes: Uint8Array): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    text = latin1(bytes);
  }
  const parts = text.split("\n");
  const tail = parts.pop();
  const lines = parts.map((line) => trimStart(line.endsWith("\r") ? line.slice(0, -1) : line));
  if (tail) lines.push(trimStart(tail));
  if (!text.includes("=?")) return lines.join(" ");
  let result = "";
  let saved: { kind: "space" | "newline"; text: string } | "word" | null = null;
  const emit = (kind: "text" | "space" | "word", text: string) => {
    if (kind === "text") {
      if (saved !== null && saved !== "word") result += saved.text;
      saved = null;
      result += text;
    } else if (kind === "space") {
      if (saved === "word") saved = { kind: "space", text };
      else {
        result += text;
        saved = null;
      }
    } else {
      saved = "word";
      result += text;
    }
  };
  lines.forEach((line, number) => {
    if (number) {
      if (saved === "word") saved = { kind: "newline", text: " " };
      else if (saved !== null && saved.kind === "space") saved = { kind: "newline", text: `${saved.text} ` };
      else {
        result += " ";
        saved = null;
      }
    }
    tokenizeLine(line, emit);
  });
  return result;
}

function tokenizeLine(line: string, emit: (kind: "text" | "space" | "word", text: string) => void) {
  const plain = (text: string) => emit(trimEnd(text) ? "text" : "space", text);
  const ascii = !/[^\0-\x7f]/.test(line);
  const points = ascii ? [] : [...line];
  const byte = (position: number) => (ascii ? position : encoder.encode(line.slice(0, position)).length);
  const boundary = (index: number) => {
    const character = index < 0 ? undefined : ascii ? line[index] : points[index];
    return character === undefined || /[\p{White_Space}"()<>,]/u.test(character);
  };
  let search = 0;
  for (;;) {
    const found = line.indexOf("=?", search);
    if (found < 0) return plain(line.slice(search));
    const begin = found + 2;
    if (!boundary(byte(found) - 1)) {
      emit("text", line.slice(search, begin));
      search = begin;
      continue;
    }
    plain(line.slice(search, found));
    let end = line.indexOf("?=", begin);
    while (end >= 0 && !boundary(byte(end) + 2)) end = line.indexOf("?=", end + 2);
    if (end < 0) {
      emit("text", "=?");
      search = found + 2;
      continue;
    }
    const decoded = decodeWord(line.slice(begin, end));
    if (decoded === null) emit("text", line.slice(found, end + 2));
    else emit("word", decoded);
    search = end + 2;
  }
}

function decodeWord(encoded: string): string | null {
  const first = encoded.indexOf("?");
  const second = first < 0 ? -1 : encoded.indexOf("?", first + 1);
  if (second < 0) return null;
  const coding = encoded.slice(first + 1, second);
  const input = encoded.slice(second + 1);
  let bytes: Uint8Array;
  if (coding === "B" || coding === "b") {
    try {
      bytes = /[\t\n\f\r ]/.test(input) ? exactBase64(input) : base64(input);
    } catch {
      return null;
    }
  } else if (coding === "Q" || coding === "q") {
    const spaced = input.replaceAll("_", " ");
    const trimmed = trimEnd(spaced);
    const decoded = quotedPrintable(trimmed);
    const rest = encoder.encode(spaced.slice(trimmed.length));
    bytes = new Uint8Array(decoded.length + rest.length);
    bytes.set(decoded);
    bytes.set(rest, decoded.length);
  } else return null;
  const decoder = decoderFor(encoded.slice(0, first), false);
  return decoder && decoder.decode(bytes);
}

function decoderFor(label: string, body: boolean) {
  const key = `${body}:${label}`;
  let decoder = decoders.get(key);
  if (decoder === undefined) {
    decoder = createDecoder(label, body);
    decoders.set(key, decoder);
  }
  return decoder;
}

function createDecoder(label: string, body: boolean): Decoder | null {
  try {
    return new TextDecoder(label, { ignoreBOM: !body });
  } catch {}
  const name = asciiLower(label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""));
  if (body && replacement.has(name)) return { decode: (bytes) => (bytes.length ? "\ufffd" : "") };
  if (utf7Labels.has(name)) return { decode: utf7 };
  const alias = extended[name];
  return alias === undefined ? null : new TextDecoder(alias, { ignoreBOM: !body });
}

function utf7(bytes: Uint8Array): string {
  const text = latin1(bytes);
  let index = 0;
  const run = (pattern: RegExp) => {
    pattern.lastIndex = index;
    const [match = ""] = pattern.exec(text) ?? [];
    index += match.length;
    return match;
  };
  let output = run(/[^+\x80-\xff]*/y);
  while (index < text.length) {
    if (text[index++] !== "+") output += "\ufffd";
    else {
      const encoded = run(/[A-Za-z0-9+/]*/y);
      let length = encoded.length;
      while (length % 4 === 1 || (length % 4 > 1 && alphabet.indexOf(encoded.charAt(length - 1)) & (length % 4 === 2 ? 15 : 3))) length--;
      output += utf16.decode(Uint8Array.fromBase64(encoded.slice(0, length))) + (length < encoded.length ? "\ufffd" : "");
      if (index === text.length) return encoded ? output : `${output}\ufffd`;
      if (text[index] === "-") index++;
      if (!encoded) output += text[index - 1] === "-" ? "+" : "\ufffd";
    }
    output += run(/[^+\x80-\xff]*/y);
  }
  return output;
}

function latin1(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function base64(text: string): Uint8Array {
  try {
    return Uint8Array.fromBase64(text, { lastChunkHandling: "strict" });
  } catch {
    return exactBase64(text.replace(/[\t\n\f\r ]/g, ""));
  }
}

function exactBase64(text: string): Uint8Array {
  const positions: number[] = [];
  for (let index = 0; index < text.length; index++) if (text[index] !== "\r" && text[index] !== "\n") positions.push(index);
  const symbols = text.replace(/[\r\n]/g, "");
  const fail = (kind: string, position: number | undefined) => new Error(`Base64 decode error: ${kind} at ${position}`);
  const output: number[] = [];
  const full = symbols.length - (symbols.length % 4);
  for (let block = 0; block < full; block += 4) {
    const length = symbols.slice(block, block + 4).replace(/=+$/, "").length;
    if (length < 2) throw fail("invalid padding length", positions[block + length]);
    let bits = 0;
    for (let index = 0; index < length; index++) {
      const value = alphabet.indexOf(symbols.charAt(block + index));
      if (value < 0) throw fail("invalid symbol", positions[block + index]);
      bits |= value << (18 - 6 * index);
    }
    for (let index = 0; index < length - 1; index++) output.push((bits >> (16 - 8 * index)) & 255);
  }
  if (full < positions.length) throw fail("invalid length", positions[full]);
  return Uint8Array.from(output);
}

const hex = new Int8Array(256).fill(-1);
for (const [index, character] of [..."0123456789ABCDEF"].entries()) hex[character.charCodeAt(0)] = hex[character.toLowerCase().charCodeAt(0)] = index;
const characters = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code));

function quotedPrintable(input: string): Uint8Array {
  const text = /[^\t\n\r\x20-\x7e]/.test(input) ? input.replace(/[^\t\n\r\x20-\x7e]/g, "") : input;
  let output = "";
  let lineBreak = false;
  let equals = text.indexOf("=");
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    let end = newline < 0 ? text.length : newline;
    for (let code = text.charCodeAt(end - 1); end > start && (code === SPACE || code === TAB || code === CR); code = text.charCodeAt(end - 1)) end--;
    if (lineBreak) output += "\r\n";
    lineBreak = true;
    for (let index = start; ; ) {
      if (equals >= 0 && equals < index) equals = text.indexOf("=", index);
      if (equals < 0 || equals >= end) {
        output += text.slice(index, end);
        break;
      }
      output += text.slice(index, equals);
      if (equals + 1 === end) {
        lineBreak = false;
        break;
      }
      if (equals + 2 === end) {
        output += text.slice(equals, end);
        break;
      }
      const high = hex[text.charCodeAt(equals + 1)] ?? -1;
      const low = hex[text.charCodeAt(equals + 2)] ?? -1;
      output += high >= 0 && low >= 0 ? (characters[(high << 4) | low] ?? "") : text.slice(equals, equals + 3);
      index = equals + 3;
    }
    start = newline < 0 ? text.length : newline + 1;
  }
  if (text.endsWith("\n") && lineBreak) output += "\r\n";
  return Buffer.from(output, "latin1");
}

function parseContentType(header: string): ContentType {
  const { value, params } = parameters(header);
  return { mimetype: value.toLowerCase(), charset: params.get("charset") ?? "us-ascii", params };
}

function parameters(content: string) {
  const [value = "", ...tokens] = content.split(";");
  const params = new Map<string, string>();
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator < 0) continue;
    const key = trim(token.slice(0, separator)).toLowerCase();
    const raw = trim(token.slice(separator + 1));
    params.set(key, raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
  }
  if (![...params.keys()].some((key) => key.includes("*"))) return { value: trim(value), params };
  const sorted = [...params.keys()].sort();
  const encoded = sorted.filter((key) => key.endsWith("*")).map((key) => key.slice(0, -1)).filter((key) => !params.has(key));
  const encodings = new Map<string, [encoding: string, strip: boolean]>();
  for (const key of encoded) {
    const [charset = ""] = (params.get(`${key}*`) ?? "").split("'");
    if (key.endsWith("*0")) {
      const prefix = `${key.slice(0, -2)}*`;
      for (const continuation of encoded) if (continuation.startsWith(prefix)) encodings.set(continuation, [charset, continuation === key]);
    } else if (!encodings.has(key)) encodings.set(key, [charset, true]);
  }
  for (const [key, [charset, strip]] of encodings) {
    const decoder = decoderFor(charset, false);
    if (!decoder) continue;
    const percent = params.get(`${key}*`) ?? "";
    params.delete(`${key}*`);
    params.set(key, decoder.decode(percentDecode(strip ? percent.split("'").slice(2).join("'") : percent)));
  }
  for (const key of [...params.keys()].sort().filter((key) => key.endsWith("*0")).map((key) => key.slice(0, -2))) {
    if (params.has(key)) continue;
    let joined = "";
    for (let index = 0, part = params.get(`${key}*0`); part !== undefined; part = params.get(`${key}*${++index}`)) {
      joined += part;
      params.delete(`${key}*${index}`);
    }
    params.set(key, joined);
  }
  return { value: trim(value), params };
}

const percentDecode = (text: string) => Buffer.from(latin1(encoder.encode(text)).replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");

const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthNames = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const zones: Record<string, number> = { UTC: 0, UT: 0, GMT: 0, Z: 0, EDT: -400, EST: -500, CDT: -500, CST: -600, MDT: -600, MST: -700, PDT: -700, PST: -800, A: -100, M: -1200, N: 100, Y: 1200 };

export function dateparse(date: string): number {
  const unsigned = (token: string, max: number) => (/^\+?\d+$/.test(token) && Number(token) <= max ? Number(token) : null);
  let result = 0;
  let month = 0;
  let day = 0;
  let state = 0;
  for (const token of date.split(/[ :]/)) {
    if (!token) continue;
    if (state === 0) {
      const value = unsigned(token, 255);
      if (value === null) continue;
      if (value < 1 || value > 31) throw new Error("Invalid day");
      day = value;
    } else if (state === 1) {
      const upper = token.toUpperCase();
      month = Math.max(months.indexOf(upper), monthNames.indexOf(upper));
      if (month < 0) throw new Error("Unrecognized month");
    } else if (state === 2) {
      const value = unsigned(token, 4294967295);
      if (value === null) throw new Error("Invalid year");
      const year = value < 70 ? 2000 + value : value < 100 ? 1900 + value : value;
      if (year < 1970) throw new Error("Disallowed year");
      const cycles = Math.floor((year - 1970) / 400);
      result = Date.UTC(year - cycles * 400, month, 1) / 1000 + cycles * 12622780800 + (day - 1) * 86400;
    } else if (state < 6) {
      const value = unsigned(token, 255);
      if (value === null) throw new Error(`Invalid ${["hour", "minute", "second"][state - 3]}`);
      result += value * 60 ** (5 - state);
    } else {
      const zone = /^[+-]?\d+$/.test(token) ? Number(token) : zones[token.toUpperCase()];
      if (zone === undefined || zone < -2400 || zone > 2400) throw new Error("Invalid timezone");
      const offset = Math.abs(zone);
      result -= Math.sign(zone || 1) * (Math.trunc(offset / 100) * 3600 + (offset % 100) * 60);
      break;
    }
    state++;
  }
  return result;
}

export function attachmentName(part: Part): string | null {
  const disposition = part.disposition();
  const filename = disposition.params.get("filename") ?? part.ctype.params.get("name") ?? null;
  if (disposition.type !== "attachment" && part.header("Content-ID") !== null) return null;
  return filename ?? (disposition.type === "attachment" ? "Unnamed attachment" : null);
}

export const base64Lines = (bytes: Uint8Array) => bytes.toBase64().replace(/.{1,76}/g, "$&\r\n");
