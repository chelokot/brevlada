import { spawn } from "../gi";
import type { Message } from "../models";
import { filters, type Filters } from "../models/search";

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

export type Input = { tickets: Int32Array } | { query: Query; messages: Message[] | null; senderMessages: Message[] | null };

export const locationKey = ({ account, folder }: Location, sender: string) => `${account.length}:${account}${folder.length}:${folder}${sender}`;

export function request(threads: boolean, query: string, sender: string | null, own: string | null, messages: Message[]): Request {
  return { threads, filters: filters(), scope: null, query, sender, own, messages, senderMessages: null, unreadFirst: true, deferredRead: new Set() };
}

const lane = (threads: boolean) => (threads ? 1 : 0);
type Snapshot = Pick<Request, "messages" | "senderMessages">;
const unsent = (): Snapshot => ({ messages: [], senderMessages: null });

export class Search {
  readonly #worker = spawn(new URL("./search/worker.ts", import.meta.url));
  readonly #tickets = new Int32Array(new SharedArrayBuffer(8));
  readonly #sent: [Snapshot, Snapshot] = [unsent(), unsent()];

  private constructor(receive: (response: Response) => void) {
    this.#worker.onmessage = ({ data }: MessageEvent<string>) => receive(JSON.parse(data));
    this.#worker.postMessage({ tickets: this.#tickets } satisfies Input);
  }

  static start(receive: (response: Response) => void): Search {
    return new Search(receive);
  }

  submit({ messages, senderMessages, ...request }: Request): void {
    const index = lane(request.threads);
    const sent = this.#sent[index];
    this.#sent[index] = { messages, senderMessages };
    this.#worker.postMessage({
      query: { ...request, ticket: Atomics.add(this.#tickets, index, 1) + 1 },
      messages: messages === sent.messages ? null : messages,
      senderMessages: senderMessages === sent.senderMessages ? null : (senderMessages ?? []),
    } satisfies Input);
  }

  cancel(threads: boolean): void {
    Atomics.add(this.#tickets, lane(threads), 1);
  }

  accepts(response: Response): boolean {
    return Atomics.load(this.#tickets, lane(response.threads)) === response.ticket;
  }

  stop(): void {
    this.#worker.terminate();
  }
}
