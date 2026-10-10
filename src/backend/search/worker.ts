import { listHeader, prepareDisplay, threads, type Message } from "../../models";
import { fields, includesDate, matchesFields } from "../../models/search";
import { key } from "../../models/senders";
import type { Input, Query } from "../search";
import { Cache, type Group, item, sameFields, type Send, sortGroups, type Work } from "./senders";
import { type Packed, References, unpack, type Wire } from "./wire";

declare const self: Worker;

interface Lane {
  messages: Message[];
  senderMessages: Message[];
  pending: Query | null;
}

interface Indexed {
  message: Message;
  fields: string[];
  sender: string;
}

interface Index {
  source: Message[];
  senderSource: Message[];
  sender: string | null;
  entries: Indexed[];
}

let tickets: Int32Array<ArrayBufferLike> = new Int32Array(2);
const lanes: [Lane, Lane] = [
  { messages: [], senderMessages: [], pending: null },
  { messages: [], senderMessages: [], pending: null },
];
const cache = new Cache();
let index: Index | null = null;
let next: 0 | 1 = 0;
let running = false;
const sent = new Set<number>();
const references = new References();

const send: Send = (response, groups) => {
  const headers: Wire["headers"] = [];
  const refs = groups.map(([, items]) =>
    items.map((item) => {
      if (!sent.has(item.ref)) {
        sent.add(item.ref);
        headers.push([item.ref, item.header()]);
      }
      return item.ref;
    }),
  );
  if (response.complete) references.complete(response.threads, refs.flat(), sent);
  self.postMessage(JSON.stringify({ ...response, locations: groups.map(([location]) => location), groups: refs, headers } satisfies Wire));
};

const identity = (message: Message) => `${message.uid}:${message.messageId}`;

function indexed(work: Work, current: () => boolean): Index | null {
  if (index && index.source === work.messages && index.senderSource === work.senderMessages && index.sender === work.sender) return index;
  const scoped = new Map<string, Message>();
  for (const message of [...work.messages, ...work.senderMessages]) {
    if (!current()) return null;
    const sender = key(message);
    if (work.sender === sender || work.own === sender) scoped.set(identity(message), message);
  }
  const previous = new Map(index ? index.entries.map((entry) => [identity(entry.message), entry]) : []);
  const entries: Indexed[] = [];
  for (const message of scoped.values()) {
    if (!current()) return null;
    const old = previous.get(identity(message));
    entries.push(
      old && sameFields(message, old.message)
        ? { message, fields: old.fields, sender: old.sender }
        : { message, fields: fields(message).map((field) => field.toLowerCase()), sender: key(message) },
    );
  }
  return { source: work.messages, senderSource: work.senderMessages, sender: work.sender, entries };
}

function threadGroups({ entries }: Index, work: Work, current: () => boolean): Group[] | null {
  const matched: Message[] = [];
  for (const { message, fields, sender } of entries) {
    if (!current()) return null;
    if ((work.sender === sender || work.own === sender) && includesDate(work.filters, message.timestamp) && matchesFields(work.filters, fields, work.query)) {
      const copy = { ...message };
      prepareDisplay(copy);
      matched.push(listHeader(copy, true));
    }
  }
  return threads(matched, "")
    .filter((group) => group.some((message) => key(message) === work.sender))
    .map((group) => [null, group.map(item)]);
}

function execute(work: Work) {
  const current = () => Atomics.load(tickets, Number(work.threads)) === work.ticket;
  const { threads, ticket, query } = work;
  if (!current()) return;
  if (!threads) {
    try {
      cache.search(work, current, send);
    } catch (error) {
      if (current()) send({ threads, ticket, query, error: error instanceof Error ? error.message : String(error), complete: true }, []);
    }
    return;
  }
  const built = indexed(work, current);
  if (built === null) return;
  index = built;
  const groups = threadGroups(built, work, current);
  if (groups === null || !current()) return;
  send({ threads, ticket, query, error: null, complete: true }, sortGroups(groups, work));
}

async function run() {
  running = true;
  while (lanes[0].pending || lanes[1].pending) {
    const turn = lanes[next].pending ? next : next === 0 ? 1 : 0;
    next = turn === 0 ? 1 : 0;
    const { pending, messages, senderMessages } = lanes[turn];
    lanes[turn].pending = null;
    if (pending) execute({ ...pending, messages, senderMessages });
    await Bun.sleep(0);
  }
  running = false;
}

const texts: string[] = [];
const unpacked = (packed: Packed) => {
  const text = texts.shift();
  if (text === undefined) throw new Error("Search snapshot arrived without its texts");
  return unpack(packed, text);
};

self.onmessage = ({ data }: MessageEvent<Input>) => {
  if (typeof data === "string") {
    texts.push(data);
    return;
  }
  if ("tickets" in data) {
    tickets = data.tickets;
    return;
  }
  const lane = lanes[data.query.threads ? 1 : 0];
  if (data.messages) lane.messages = unpacked(data.messages);
  if (data.senderMessages) lane.senderMessages = unpacked(data.senderMessages);
  lane.pending = data.query;
  if (!running) void run();
};
