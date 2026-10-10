import type { Account, Draft } from "../models";
import type { Target } from "../models/draft";
import { sameAscii } from "../models/text";
import { failure } from "./protocol";
import { quote, type Session } from "./imap";
import { Mail } from "./mail";
import { ensureDraftId, syncFolders } from "./mail-sync";
import { attachmentName, base64Lines, parseMail, type Part } from "./mime";
import { normalizeMessageId, parse } from "./parser";
import type { Storage } from "./storage";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export async function prepareSend(account: Account, draft: Draft, target: Target | null): Promise<Draft> {
  if (draft.attachmentsLoaded) return draft;
  if (target) {
    await using mail = await Mail.connect(account);
    const location = await resolve(mail.session, target);
    if (!location) throw new Error("Draft is no longer on the server");
    return { ...draft, attachments: [...(await attachments(mail.session, target.folder, ...location, draft.removedAttachments)), ...draft.attachments] };
  }
  const source = draft.attachmentSource;
  if (!source) return draft;
  await using mail = await Mail.connect(account);
  const folder = source.folder || (await syncFolders(mail)).sent;
  if (folder === null) throw new Error("This account has no Sent folder");
  return { ...draft, attachments: [...(await forwardAttachments(mail.session, { ...source, folder }, draft.removedAttachments)), ...draft.attachments] };
}

export async function forwardAttachments(session: Session, source: Target, removed: number[]): Promise<string[]> {
  const validity = (await session.examine(source.folder)).uidValidity;
  if (validity === null) throw new Error("Missing UIDVALIDITY for forwarded message");
  if (source.validity !== null && source.validity !== validity) throw new Error("Source mailbox changed; reopen the message before forwarding");
  let uid = source.uid;
  if (uid === 0) {
    if (!source.messageId) throw new Error("Forwarded message identity is unavailable");
    const [found, ...others] = await session.uidSearch(`HEADER Message-ID ${quote(source.messageId)}`);
    if (found === undefined || others.length) throw new Error("Forwarded message is missing or ambiguous");
    uid = found;
  }
  const item = (await session.uidFetch(String(uid), "(UID BODY.PEEK[])")).find((item) => item.uid === uid && item.body);
  if (!item || !item.body) throw new Error("Forwarded message is no longer on the server");
  if (parse(uid, item.body, true, false).messageId !== normalizeMessageId(source.messageId)) throw new Error("Source message changed; reopen it before forwarding");
  return retainSelected(parseMail(item.body), removed);
}

async function attachments(session: Session, folder: string, validity: number, uid: number, removed: number[]): Promise<string[]> {
  if ((await session.select(folder)).uidValidity !== validity) throw new Error("Draft mailbox changed while reading attachments");
  const item = (await session.uidFetch(String(uid), "(UID BODY.PEEK[])")).find((item) => item.uid === uid && item.body);
  if (!item || !item.body) throw new Error("Draft is no longer on the server");
  return retainSelected(parseMail(item.body), removed);
}

export function retainSelected(root: Part, removed: number[]): string[] {
  const retained: string[] = [];
  let index = 0;
  const visit = (mail: Part) => {
    if (attachmentName(mail) !== null && removed.includes(index++)) return;
    const disposition = mail.disposition();
    const attachment = disposition.type === "attachment" || disposition.params.has("filename") || mail.ctype.params.has("name");
    if (!attachment && mail.subparts.length) mail.subparts.forEach(visit);
    else if (attachment || !["text/plain", "text/html"].includes(mail.ctype.mimetype)) {
      const headers = mail.headers.filter(({ key }) => !sameAscii(key, "Content-Transfer-Encoding")).map(({ key, value }) => `${key}: ${decoder.decode(value)}\r\n`);
      retained.push(`${headers.join("")}Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(mail.bodyRaw())}`);
    }
  };
  visit(root);
  return retained;
}

export async function deleteDraft(account: Account, target: Target, storage: Storage) {
  await using mail = await Mail.connect(account);
  const location = await resolve(mail.session, target);
  if (location) await removeUid(mail.session, target.folder, ...location);
  try {
    storage.deleteDraft(account.email, location ? { ...target, validity: location[0], uid: location[1] } : target);
  } catch (error) {
    console.error(`Could not remove deleted draft from cache: ${failure(error)}`);
  }
}

export async function resolve(session: Session, target: Target): Promise<[validity: number, uid: number] | null> {
  const validity = (await session.select(target.folder)).uidValidity;
  if (validity === null) throw new Error("Missing UIDVALIDITY");
  if (target.validity !== null && target.validity !== validity) throw new Error("Draft mailbox changed; reload before deleting or replacing this draft");
  let uid = target.uid;
  if (uid === 0 || target.validity === null) {
    if (!target.messageId || target.messageId.startsWith("brevlada-draft:")) throw new Error("Draft mailbox identity is unavailable; reload the draft");
    const found = await session.uidSearch(`HEADER Message-ID ${quote(target.messageId)}`);
    if (!found.length) return null;
    uid = Math.min(...found);
  }
  const item = (await session.uidFetch(String(uid), "(UID FLAGS BODY.PEEK[HEADER])")).find((item) => item.uid === uid);
  if (!item) return null;
  if (!item.header) throw new Error("Missing draft headers");
  const header = parse(uid, item.header, true, false);
  header.isDraft = true;
  ensureDraftId(header, target.folder);
  if (header.messageId !== target.messageId) throw new Error("Draft changed on the server; reload before deleting or replacing it");
  return [validity, uid];
}

export async function removeUid(session: Session, folder: string, validity: number, uid: number) {
  if (!(await session.capabilities()).has("UIDPLUS")) throw new Error("Mail server needs UIDPLUS support to delete a draft safely");
  if ((await session.select(folder)).uidValidity !== validity) throw new Error("Draft mailbox changed during deletion");
  await session.uidStore(String(uid), "+FLAGS.SILENT (\\Deleted)");
  await session.uidExpunge(String(uid));
}
