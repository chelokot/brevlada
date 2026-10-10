import { existsSync } from "node:fs";
import { listHeader, type Message } from "../../models";
import { htmlText, includesDate } from "../../models/search";
import { key } from "../../models/senders";
import { locationKey, type Location, type Query, type Response } from "../search";
import { Storage } from "../storage";

export type Work = Query & { messages: Message[]; senderMessages: Message[] };

export interface Item {
  readonly ref: number;
  header(): Message;
}

export type Group = [location: Location | null, items: Item[]];
export type Send = (response: Omit<Response, "groups" | "locations">, groups: Group[]) => void;

let references = 0;
export const reference = () => ++references;
export const item = (message: Message): Item => ({ ref: reference(), header: () => message });

export const sameFields = (a: Message, b: Message) =>
  a.subject === b.subject &&
  a.sender === b.sender &&
  a.replyTo === b.replyTo &&
  a.recipients === b.recipients &&
  a.cc === b.cc &&
  a.bodyText === b.bodyText &&
  a.bodyHtml === b.bodyHtml;

const sameLocation = (a: Location | null, b: Location) => a !== null && a.account === b.account && a.folder === b.folder;
const newestFirst = (a: Message, b: Message) => b.timestamp - a.timestamp || b.uid - a.uid;
const FIELDS = [0, 1, 2, 3, 4, 5, 6];
const BUCKETS = 2048;

const scratch = new Uint8Array(BUCKETS);
const pair = (text: string, index: number) => (text.charCodeAt(index) * 31 + text.charCodeAt(index + 1)) & (BUCKETS - 1);
export const pairs = (query: string) => [...new Set(Array.from({ length: Math.max(query.length - 1, 0) }, (_, index) => pair(query, index)))];

export function sortGroups(groups: Group[], { unreadFirst, scope, deferredRead }: Work): Group[] {
  const ranked = groups.map((group) => {
    const [location, items] = group;
    const messages = items.map((item) => item.header());
    const newest = messages.reduce((best, message) => (newestFirst(best, message) > 0 ? message : best));
    const deferred = location === null || (scope !== null && sameLocation(scope.current, location));
    const unread = unreadFirst && messages.some((message) => !message.isRead || (deferred && deferredRead.has(message.uid)));
    return { group, rank: [Number(unread), newest.timestamp, newest.uid] as const };
  });
  return ranked.sort(({ rank: a }, { rank: b }) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]).map(({ group }) => group);
}

export class Entry implements Item {
  readonly sender: string;
  readonly fields: (string | undefined)[] = [];
  #ref = reference();
  #header: Message | null = null;
  #prefiltered = false;
  #signature: Int32Array | null = null;

  constructor(
    public message: Message,
    readonly text: () => string,
    readonly html: () => string,
  ) {
    this.sender = key(message);
  }

  get ref(): number {
    return this.#ref;
  }

  update(message: Message) {
    this.message = message;
    this.#ref = reference();
    this.#header = null;
  }

  static memory(message: Message): Entry {
    const entry = new Entry(message, () => message.bodyText, () => message.bodyHtml && htmlText(message.bodyHtml));
    entry.#prefiltered = !message.bodyHtml;
    return entry;
  }

  matches({ filters, query }: Pick<Query, "filters" | "query">, hashes: number[]): boolean {
    if (!includesDate(filters, this.message.timestamp)) return false;
    if (!query) return true;
    if (this.#prefiltered && !this.#covers(hashes)) return false;
    return FIELDS.some((index) => filters.sources[Math.min(index, 5)] && this.#field(index).includes(query));
  }

  #field(index: number): string {
    return (this.fields[index] ??= this.#raw(index).toLowerCase());
  }

  #covers(hashes: number[]): boolean {
    const signature = (this.#signature ??= this.#sign());
    return hashes.every((hash) => (Atomics.load(signature, hash >>> 5) & (1 << (hash & 31))) !== 0);
  }

  #sign(): Int32Array {
    const signature = new Int32Array(BUCKETS / 32);
    for (const index of FIELDS.slice(0, 6)) {
      const text = this.#field(index);
      for (let position = 0; position < text.length - 1; position++) scratch[pair(text, position)] = 1;
    }
    scratch.forEach((present, bucket) => present && Atomics.or(signature, bucket >>> 5, 1 << (bucket & 31)));
    scratch.fill(0);
    return signature;
  }

  #raw(index: number): string {
    const { subject, sender, replyTo, recipients, cc } = this.message;
    return [subject, sender, replyTo, recipients, cc][index] ?? (index === 5 ? this.text() : this.html());
  }

  header(): Message {
    return (this.#header ??= { ...listHeader(this.message, false), searchMatch: true });
  }
}

class Progress {
  readonly #groups = new Map<string, Group>();
  readonly #hashes: number[];
  #lastSent: number | null = null;

  constructor(
    readonly work: Work,
    readonly current: () => boolean,
    readonly send: Send,
  ) {
    this.#hashes = pairs(work.query);
  }

  visit(location: Location | null, entry: Entry): boolean {
    if (!this.current()) return false;
    if (!entry.matches(this.work, this.#hashes)) return true;
    const id = location === null ? entry.sender : locationKey(location, entry.sender);
    let group = this.#groups.get(id);
    if (!group) this.#groups.set(id, (group = [location, []]));
    group[1].push(entry);
    return this.#lastSent === null || performance.now() - this.#lastSent >= 60 ? this.publish(false) : true;
  }

  publish(complete: boolean): boolean {
    if (!this.current()) return false;
    const newest = (a: Item, b: Item) => newestFirst(a.header(), b.header());
    const groups = sortGroups([...this.#groups.values()].map(([location, group]) => [location, group.sort(newest)]), this.work);
    const { threads, ticket, query } = this.work;
    this.send({ threads, ticket, query, error: null, complete }, groups);
    this.#lastSent = performance.now();
    return true;
  }
}

interface Mailbox {
  location: Location | null;
  source: Message[] | string | null;
  entries: Map<number, Entry>;
  ordered: [key: number, entry: Entry][];
}

export class Cache {
  #path: string | null = null;
  #storage: Storage | null = null;
  readonly #mailboxes = new Map<string, Mailbox>();

  search(work: Work, current: () => boolean, send: Send): void {
    const progress = new Progress(work, current, send);
    const { scope } = work;
    if (scope) {
      if (this.#path !== scope.cachePath) {
        this.#mailboxes.clear();
        this.#storage?.close();
        this.#storage = null;
        this.#path = scope.cachePath;
      }
      for (const [id, { location }] of this.#mailboxes) {
        if (location === null || (scope.folder !== null && location.folder !== scope.folder)) this.#mailboxes.delete(id);
      }
      const outside = (account: string) => scope.current === null || scope.current.account !== account || scope.current.folder !== scope.folder;
      if (this.#storage === null && existsSync(scope.cachePath) && scope.accounts.length > 0 && (scope.folder === null || scope.accounts.some(outside))) {
        this.#storage = Storage.openReadOnly(scope.cachePath);
      }
    }
    const locations: (Location | null)[] = scope
      ? scope.accounts.flatMap((account) => {
          const folders = scope.folder === null ? (this.#storage?.searchFolders(account) ?? []) : [scope.folder];
          if (scope.folder === null && scope.current?.account === account && !folders.includes(scope.current.folder)) folders.push(scope.current.folder);
          return folders.map((folder) => ({ account, folder }));
        })
      : [null];
    const stamp = `${this.#storage?.searchDataVersion() ?? 0}:${scope?.revision ?? 0}`;
    const candidates = this.#storage?.searchCandidates(work.query) ?? null;
    for (const location of locations) {
      if (!current()) return;
      const memory = location === null || (scope !== null && sameLocation(scope.current, location));
      const id = `${memory}:${location === null ? "" : locationKey(location, "")}`;
      let mailbox = this.#mailboxes.get(id);
      if (!mailbox) this.#mailboxes.set(id, (mailbox = { location, source: null, entries: new Map(), ordered: [] }));
      if (memory) {
        if (!this.#memory(mailbox, work, progress, current)) return;
      } else if (location !== null && this.#storage && !this.#disk(this.#storage, mailbox, location, stamp, candidates, progress, current)) {
        return;
      }
    }
    progress.publish(true);
  }

  #memory(mailbox: Mailbox, work: Work, progress: Progress, current: () => boolean): boolean {
    const { location, entries } = mailbox;
    if (mailbox.source === work.messages) return mailbox.ordered.every(([, entry]) => progress.visit(location, entry));
    mailbox.source = null;
    const seen = new Set<number>();
    const visit = (message: Message) => {
      if (!current()) return false;
      seen.add(message.uid);
      let entry = entries.get(message.uid);
      if (entry && sameFields(entry.message, message)) entry.update(message);
      else entries.set(message.uid, (entry = Entry.memory(message)));
      return progress.visit(location, entry);
    };
    if (![...work.messages].sort(newestFirst).every(visit) || !current()) return false;
    for (const uid of entries.keys()) if (!seen.has(uid)) entries.delete(uid);
    this.#settle(mailbox, work.messages);
    return true;
  }

  #disk(
    storage: Storage,
    mailbox: Mailbox,
    location: Location,
    stamp: string,
    candidates: Set<number> | null,
    progress: Progress,
    current: () => boolean,
  ): boolean {
    const { entries } = mailbox;
    if (mailbox.source !== stamp) {
      mailbox.source = null;
      entries.clear();
      storage.visitSearchMessages(location.account, location.folder, (message, id) => {
        const body = (column: "bodyText" | "htmlText") => () => storage.searchBody(id, column);
        entries.set(id, new Entry(message, body("bodyText"), body("htmlText")));
        return current();
      });
      if (!current()) return false;
      this.#settle(mailbox, stamp);
    }
    return mailbox.ordered.every(([id, entry]) => (candidates !== null && !candidates.has(id)) || progress.visit(location, entry));
  }

  #settle(mailbox: Mailbox, source: Message[] | string) {
    mailbox.source = source;
    mailbox.ordered = [...mailbox.entries].sort(([, a], [, b]) => newestFirst(a.message, b.message));
  }
}
