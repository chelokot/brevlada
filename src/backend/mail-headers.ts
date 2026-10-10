import type { Message } from "../models";
import type { Session } from "./imap";
import { applyFlags } from "./mail-sync";
import { parse } from "./parser";

export async function fetch(session: Session, folder: string, drafts: string | null, validity: number, uids: number[]): Promise<Message[]> {
  if (!uids.length) return [];
  const requested = new Set(uids);
  const messages: Message[] = [];
  for (const { uid, flags, header } of await session.uidFetch(uids.join(","), "(UID FLAGS BODY.PEEK[HEADER])")) {
    if (!header) continue;
    if (uid === null) throw new Error("Missing message UID");
    if (!requested.has(uid)) continue;
    const message = parse(uid, header, flags.includes("\\Seen"), false);
    message.uidValidity = validity;
    applyFlags(message, folder, flags, drafts);
    messages.push(message);
  }
  return messages;
}
