import type { Message } from "../../models";
import type { Response } from "../search";

export type Wire = Omit<Response, "groups"> & { groups: number[][]; headers: [ref: number, header: Message][] };

export type Packed = (Omit<Message, "bodyText" | "bodyHtml"> & { textLength: number; htmlLength: number })[];

export function pack(messages: Message[]): [packed: Packed, texts: string] {
  const texts: string[] = [];
  const packed = messages.map(({ bodyText, bodyHtml, ...header }) => {
    texts.push(bodyText, bodyHtml);
    return { ...header, textLength: bodyText.length, htmlLength: bodyHtml.length };
  });
  return [packed, texts.join("")];
}

export function unpack(packed: Packed, texts: string): Message[] {
  let offset = 0;
  const slice = (length: number) => texts.slice(offset, (offset += length));
  return packed.map(({ textLength, htmlLength, ...header }) => ({ ...header, bodyText: slice(textLength), bodyHtml: slice(htmlLength) }));
}

const LIMIT = 65536;

export class References {
  readonly #kept: [number[], number[]] = [[], []];

  complete(threads: boolean, refs: number[], known: Set<number> | Map<number, Message>) {
    this.#kept[threads ? 1 : 0] = refs;
    if (known.size <= LIMIT) return;
    const keep = new Set(this.#kept.flat());
    for (const ref of known.keys()) if (!keep.has(ref)) known.delete(ref);
  }
}
