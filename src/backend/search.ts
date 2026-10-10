import { spawn } from "../gi";
import type { Message } from "../models";
import { filters, type Filters } from "../models/search";
import { searchWorker } from "../workers";
import { pack, type Packed, References, type Wire } from "./search/wire";

export interface Location {
  account: string;
  folder: string;
}

export interface Scope {
  current: Location | null;
  folder: string | null;
  accounts: string[];
  cachePath: string;
  revision: number;
}

export interface Request {
  threads: boolean;
  filters: Filters;
  scope: Scope | null;
  query: string;
  sender: string | null;
  own: string | null;
  messages: Message[];
  senderMessages: Message[] | null;
  unreadFirst: boolean;
  deferredRead: Set<number>;
}

export interface Response {
  threads: boolean;
  ticket: number;
  query: string;
  groups: Message[][];
  locations: (Location | null)[];
  error: string | null;
  complete: boolean;
}

export type Query = Omit<Request, "messages" | "senderMessages"> & { ticket: number };

export type Input = string | { tickets: Int32Array } | { query: Query; messages: Packed | null; senderMessages: Packed | null };

export const locationKey = ({ account, folder }: Location, sender: string) => `${account.length}:${account}${folder.length}:${folder}${sender}`;

export function request(threads: boolean, query: string, sender: string | null, own: string | null, messages: Message[]): Request {
  return { threads, filters: filters(), scope: null, query, sender, own, messages, senderMessages: null, unreadFirst: true, deferredRead: new Set() };
}

const lane = (threads: boolean) => (threads ? 1 : 0);
type Snapshot = Pick<Request, "messages" | "senderMessages">;
const unsent = (): Snapshot => ({ messages: [], senderMessages: null });

export class Search {
  #worker: Worker | null = null;
  readonly #tickets = new Int32Array(new SharedArrayBuffer(8));
  readonly #sent: [Snapshot, Snapshot] = [unsent(), unsent()];
  readonly #headers = new Map<number, Message>();
  readonly #references = new References();

  readonly #receive: (response: Response) => void;

  private constructor(receive: (response: Response) => void) {
    this.#receive = receive;
  }

  static start(receive: (response: Response) => void): Search {
    return new Search(receive);
  }

  #connected(): Worker {
    if (this.#worker) return this.#worker;
    const worker = (this.#worker = spawn(searchWorker));
    worker.onmessage = ({ data }: MessageEvent<string>) => this.#receive(this.#decode(JSON.parse(data)));
    worker.postMessage({ tickets: this.#tickets } satisfies Input);
    return worker;
  }

  submit({ messages, senderMessages, ...request }: Request): void {
    const worker = this.#connected();
    const index = lane(request.threads);
    const sent = this.#sent[index];
    this.#sent[index] = { messages, senderMessages };
    const snapshot = (current: Message[] | null, previous: Message[] | null) => {
      if (current === previous) return null;
      const [packed, texts] = pack(current ?? []);
      worker.postMessage(texts satisfies Input);
      return packed;
    };
    worker.postMessage({
      query: { ...request, ticket: Atomics.add(this.#tickets, index, 1) + 1 },
      messages: snapshot(messages, sent.messages),
      senderMessages: snapshot(senderMessages, sent.senderMessages),
    } satisfies Input);
  }

  #decode({ headers, groups, ...response }: Wire): Response {
    for (const [ref, header] of headers) this.#headers.set(ref, header);
    const decoded = groups.map((group) => group.map((ref) => this.#header(ref)));
    if (response.complete) this.#references.complete(response.threads, groups.flat(), this.#headers);
    return { ...response, groups: decoded };
  }

  #header(ref: number): Message {
    const header = this.#headers.get(ref);
    if (!header) throw new Error("Search response refers to an unknown message");
    return { ...header };
  }

  cancel(threads: boolean): void {
    Atomics.add(this.#tickets, lane(threads), 1);
  }

  accepts(response: Response): boolean {
    return Atomics.load(this.#tickets, lane(response.threads)) === response.ticket;
  }

  stop(): void {
    if (this.#worker) this.#worker.terminate();
  }
}
