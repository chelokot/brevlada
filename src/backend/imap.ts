import { sameAscii } from "../models/text";
import type { Stream } from "./stream";

type Value = string | Uint8Array | null | Value[];
type Segments = [string, ...(string | Uint8Array)[]];

export interface Mailbox {
  exists: number;
  uidValidity: number | null;
}

export interface Name {
  name: string;
  delimiter: string | null;
  attributes: string[];
}

export interface Fetch {
  uid: number | null;
  flags: string[];
  header: Uint8Array | null;
  body: Uint8Array | null;
}

export interface Status {
  mailbox: string;
  attributes: Map<string, number>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class Session {
  #tag = 0;

  constructor(readonly stream: Stream) {}

  async greeting() {
    await this.#read();
  }

  async startTls(host: string) {
    await this.#command("STARTTLS");
    await this.stream.upgrade(host);
  }

  async login(username: string, password: string) {
    await this.#command(`LOGIN ${quote(username)} ${quote(password)}`);
  }

  async authenticate(mechanism: string, response: string) {
    const tag = await this.#send(`AUTHENTICATE ${mechanism}`);
    for (;;) {
      const [line] = await this.#read();
      if (line.startsWith(`${tag} `)) return completion(line);
      if (!line.startsWith("+")) continue;
      let challenge: Uint8Array;
      try {
        if (line !== "+" && !line.startsWith("+ ")) throw new Error();
        challenge = Uint8Array.fromBase64(line.slice(2));
      } catch {
        throw new Error("Unable to parse authentication response");
      }
      await this.stream.write(`${Buffer.from(challenge.length ? "" : response).toString("base64")}\r\n`);
    }
  }

  select(folder: string) {
    return this.#open("SELECT", folder);
  }

  examine(folder: string) {
    return this.#open("EXAMINE", folder);
  }

  async list(reference: string | null, pattern: string | null): Promise<Name[]> {
    return (await this.#command(`LIST ${quote(reference ?? "")} ${pattern ?? '""'}`)).flatMap(([kind, attributes, delimiter, name]) =>
      word(kind) === "LIST" && Array.isArray(attributes) ? [{ name: mailbox(name), delimiter: typeof delimiter === "string" ? delimiter : null, attributes: attributes.map(text) }] : [],
    );
  }

  async status(folder: string, items: string): Promise<Status[]> {
    return (await this.#command(`STATUS ${quote(folder)} ${items}`)).flatMap(([kind, name, values]) => {
      if (word(kind) !== "STATUS" || !Array.isArray(values)) return [];
      const attributes = new Map<string, number>();
      for (let index = 0; index < values.length; index += 2) attributes.set(word(values[index]), Number(text(values[index + 1])));
      return [{ mailbox: mailbox(name), attributes }];
    });
  }

  async capabilities(): Promise<Set<string>> {
    return new Set((await this.#command("CAPABILITY")).flatMap(([kind, ...names]) => (word(kind) === "CAPABILITY" ? names.map(text) : [])));
  }

  async uidSearch(query: string): Promise<number[]> {
    const responses = await this.#command(`UID SEARCH ${query}`);
    return [...new Set(responses.flatMap(([kind, ...ids]) => (word(kind) === "SEARCH" ? ids.flatMap((id) => (typeof id === "string" ? [Number(id)] : [])) : [])))];
  }

  async uidFetch(uids: string, query: string): Promise<Fetch[]> {
    if (!uids) return [];
    validate(uids, /\s/);
    validate(query, /[\r\n]/);
    return (await this.#command(`UID FETCH ${uids} ${query}`)).flatMap(([, kind, attributes]) => (word(kind) === "FETCH" && Array.isArray(attributes) ? [fetchItem(attributes)] : []));
  }

  async uidStore(uids: string, query: string) {
    await this.#command(`UID STORE ${uids} ${query}`);
  }

  async uidCopy(uids: string, mailbox: string) {
    await this.#command(`UID COPY ${uids} ${mailbox}`);
  }

  async uidMv(uids: string, mailbox: string) {
    await this.#command(`UID MOVE ${uids} ${quote(mailbox)}`);
  }

  async uidExpunge(uids: string) {
    await this.#command(`UID EXPUNGE ${uids}`);
  }

  async appendWithFlags(mailbox: string, content: Uint8Array, flags: string[]) {
    const tag = await this.#send(`APPEND ${quote(mailbox)} (${flags.join(" ")}) {${content.length}}`);
    const [line] = await this.#read();
    if (!line.startsWith("+")) throw new Error("Could not append mail to mailbox");
    await this.stream.write(content);
    await this.stream.write("\r\n");
    await this.#complete(tag);
  }

  async logout() {
    await this.#command("LOGOUT");
  }

  async #open(command: string, folder: string): Promise<Mailbox> {
    const result: Mailbox = { exists: 0, uidValidity: null };
    for (const [first, second] of await this.#command(`${command} ${quote(folder)}`)) {
      const [, validity] = (word(first) === "OK" && /^\[UIDVALIDITY (\d+)\]$/i.exec(text(second))) || [];
      if (validity !== undefined) result.uidValidity = Number(validity);
      if (word(second) === "EXISTS") result.exists = Number(text(first));
    }
    return result;
  }

  async #command(command: string) {
    return this.#complete(await this.#send(command));
  }

  async #send(command: string) {
    const tag = `a${++this.#tag}`;
    await this.stream.write(`${tag} ${command}\r\n`);
    return tag;
  }

  async #complete(tag: string) {
    const responses: Value[][] = [];
    for (;;) {
      const [head, ...rest] = await this.#read();
      if (head.startsWith(`${tag} `)) {
        completion(head);
        return responses;
      }
      if (head.startsWith("* ")) responses.push(parse(head.slice(2), rest));
    }
  }

  async #read(): Promise<Segments> {
    const segments: (string | Uint8Array)[] = [];
    let head: string | null = null;
    for (;;) {
      const line = await this.stream.line();
      if (!line) throw new Error("Connection Lost");
      const text = decoder.decode(line);
      const literal = /\{(\d+)\}\r?\n$/.exec(text);
      const content = literal ? text.slice(0, literal.index) : text.replace(/\r?\n$/, "");
      if (head === null) head = content;
      else segments.push(content);
      if (!literal) return [head, ...segments];
      const bytes = await this.stream.bytes(Number(literal[1]));
      if (!bytes) throw new Error("Connection Lost");
      segments.push(bytes);
    }
  }
}

function completion(line: string) {
  const [, status = "", information = ""] = /^\S+ (\S+)(?: \[[^\]]*\])? ?(.*)$/.exec(line) ?? [];
  const explanation = information || "no explanation given";
  if (sameAscii(status, "NO")) throw new Error(`No Response: ${explanation}`);
  if (sameAscii(status, "BAD")) throw new Error(`Bad Response: ${explanation}`);
  if (!sameAscii(status, "OK")) throw new Error("Unable to parse status response");
}

export function quote(value: string) {
  validate(value, /[\r\n]/);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function validate(value: string, invalid: RegExp) {
  const [found] = invalid.exec(value) ?? [];
  if (found !== undefined) throw new Error(`Invalid character in input: ${JSON.stringify(found).replace(/^"|"$/g, "'")}`);
}

function parse(head: string, rest: (string | Uint8Array)[]): Value[] {
  const status = /^(OK|NO|BAD|BYE|PREAUTH)\b(?: (\[[^\]]*\]))?/i.exec(head);
  if (status) {
    const [, kind = "", code = ""] = status;
    return [kind.toUpperCase(), code];
  }
  const root: Value[] = [];
  const parents: Value[][] = [];
  let current = root;
  for (const segment of [head, ...rest]) {
    if (typeof segment !== "string") {
      current.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length; ) {
      const character = segment.charAt(index);
      if (character === " ") index++;
      else if (character === "(") {
        const list: Value[] = [];
        current.push(list);
        parents.push(current);
        current = list;
        index++;
      } else if (character === ")") {
        current = parents.pop() ?? root;
        index++;
      } else if (character === '"') {
        let value = "";
        for (index++; index < segment.length && segment.charAt(index) !== '"'; index++) {
          if (segment.charAt(index) === "\\") index++;
          value += segment.charAt(index);
        }
        current.push(value);
        index++;
      } else {
        let end = index;
        while (end < segment.length && !" ()".includes(segment.charAt(end))) {
          end = segment.charAt(end) === "[" ? Math.max(segment.indexOf("]", end), end) + 1 : end + 1;
        }
        const atom = segment.slice(index, end);
        current.push(sameAscii(atom, "NIL") ? null : atom);
        index = end;
      }
    }
  }
  return root;
}

function fetchItem(attributes: Value[]): Fetch {
  const result: Fetch = { uid: null, flags: [], header: null, body: null };
  for (let index = 0; index < attributes.length; index += 2) {
    const [name, value = null] = attributes.slice(index, index + 2);
    const key = word(name);
    if (key === "UID") result.uid = Number(text(value));
    else if (key === "FLAGS" && Array.isArray(value)) result.flags = value.map(text);
    else if (key === "BODY[HEADER]" || key === "RFC822.HEADER") result.header = bytes(value);
    else if (key === "BODY[]" || key === "RFC822") result.body = bytes(value);
  }
  return result;
}

function text(value: Value | undefined): string {
  return typeof value === "string" ? value : value instanceof Uint8Array ? decoder.decode(value) : "";
}

function word(value: Value | undefined) {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function mailbox(value: Value | undefined) {
  const name = text(value);
  return sameAscii(name, "INBOX") ? "INBOX" : name;
}

function bytes(value: Value): Uint8Array | null {
  return typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : null;
}
