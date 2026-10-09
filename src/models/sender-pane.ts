import type { Message } from ".";

type Cursor = [timestamp: number, uid: number];

type Paging = { kind: "Ready" } | { kind: "Loading"; ticket: number } | { kind: "Exhausted" } | { kind: "Failed" };

interface Session {
  sender: string;
  messages: Message[];
  cursor: Cursor | null;
  paging: Paging;
}

export interface PageRequest {
  sender: string;
  before: Cursor | null;
  ticket: number;
}

const older = ([timestamp, uid]: Cursor, [before, beforeUid]: Cursor) => timestamp < before || (timestamp === before && uid < beforeUid);

export class SenderPane {
  #revision = 0;
  #session: Session | null = null;

  sender() {
    return this.#session && this.#session.sender;
  }

  messages() {
    return this.#session ? this.#session.messages : [];
  }

  replace(original: Message, replacement: Message) {
    const messages = this.messages();
    messages.forEach((message, index) => {
      if (message.uid === original.uid && message.messageId === original.messageId) messages[index] = { ...replacement };
    });
  }

  remove(removed: Message[]) {
    if (!this.#session) return;
    this.#session.messages = this.#session.messages.filter(
      (message) =>
        !removed.some((old) => old.uid === message.uid && (message.uidValidity === null || old.uidValidity === message.uidValidity) && old.messageId === message.messageId),
    );
  }

  select(sender: string | null) {
    if (this.sender() === sender) return false;
    this.#revision++;
    this.#session = sender === null ? null : { sender, messages: [], cursor: null, paging: { kind: "Ready" } };
    return true;
  }

  loading() {
    return this.#session !== null && this.#session.paging.kind === "Loading";
  }

  canLoad() {
    return this.#session !== null && (this.#session.paging.kind === "Ready" || this.#session.paging.kind === "Failed");
  }

  request(): PageRequest | null {
    if (!this.#session || !this.canLoad()) return null;
    const ticket = ++this.#revision;
    this.#session.paging = { kind: "Loading", ticket };
    return { sender: this.#session.sender, before: this.#session.cursor, ticket };
  }

  accepts(ticket: number) {
    const paging = this.#session && this.#session.paging;
    return paging !== null && paging.kind === "Loading" && paging.ticket === ticket;
  }

  finish(ticket: number, messages: Message[], hasMore: boolean) {
    const session = this.#session;
    if (!session || !this.accepts(ticket)) return false;
    const last = messages.at(-1);
    const cursor: Cursor | null = last ? [last.timestamp, last.uid] : null;
    const advances = cursor !== null && (session.cursor === null || older(cursor, session.cursor));
    session.paging = { kind: hasMore && advances ? "Ready" : "Exhausted" };
    if (advances) session.cursor = cursor;
    const known = new Set(session.messages.map(({ uid, messageId }) => JSON.stringify([uid, messageId])));
    for (const message of messages) {
      const id = JSON.stringify([message.uid, message.messageId]);
      if (known.has(id)) continue;
      known.add(id);
      session.messages.push(message);
    }
    return true;
  }

  fail(ticket: number) {
    if (!this.#session || !this.accepts(ticket)) return false;
    this.#session.paging = { kind: "Failed" };
    return true;
  }

  ticket() {
    return this.#revision;
  }

  seed(messages: Message[]) {
    if (this.#session) this.#session.messages = messages;
  }
}
