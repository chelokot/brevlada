import type { Account, Draft } from "../models";
import type { Saved, Target } from "../models/draft";
import { prepareSend, removeUid, resolve } from "./drafts";
import { quote, type Session } from "./imap";
import { Mail } from "./mail";
import { syncFolders } from "./mail-sync";
import { attachmentName, parseMail } from "./mime";
import { parse } from "./parser";
import { failure } from "./protocol";
import { draftMessage } from "./smtp";
import type { Storage } from "./storage";

const encoder = new TextEncoder();

export async function save(account: Account, draft: Draft, target: Target | null, storage: Storage): Promise<Saved> {
  const originalParts = draft.attachmentsLoaded ? [] : (await prepareSend(account, { ...draft, attachments: [], removedAttachments: [] }, target)).attachments;
  let index = 0;
  const retained = originalParts.filter((part) => !(attachmentName(parseMail(encoder.encode(part))) !== null && draft.removedAttachments.includes(index++)));
  await using mail = await Mail.connect(account);
  const { drafts: folder } = await syncFolders(mail);
  if (folder === null) throw new Error("This account has no Drafts folder");
  let previous: [validity: number, uid: number] | null = null;
  if (target) {
    if (target.folder !== folder) throw new Error("The Drafts folder changed; reload before saving");
    previous = await resolve(mail.session, target);
    if (!previous) throw new Error("Draft is no longer on the server");
    if (!(await mail.session.capabilities()).has("UIDPLUS")) throw new Error("Mail server needs UIDPLUS support to replace a draft safely");
  }
  const raw = encoder.encode(draftMessage(account, { ...draft, attachments: [...retained, ...draft.attachments] }));
  const message = parse(0, raw, true, true);
  message.isDraft = true;
  await append(mail.session, folder, raw);
  let cleanupError: string | null = null;
  if (previous) {
    const [validity, uid] = previous;
    try {
      await removeUid(mail.session, folder, validity, uid);
      if (target) {
        try {
          storage.deleteDraft(account.email, { ...target, uid, validity });
        } catch (error) {
          console.error(`Could not remove replaced draft from cache: ${failure(error)}`);
        }
      }
    } catch (error) {
      cleanupError = failure(error);
    }
  }
  try {
    [message.uidValidity, message.uid] = await savedLocation(mail.session, folder, message.messageId);
    storage.storeSavedDraft(account.email, folder, message);
  } catch (error) {
    console.error(`Could not cache saved draft: ${failure(error)}`);
  }
  return { item: { folder, message }, originalParts, cleanupError };
}

export async function savedLocation(session: Session, folder: string, id: string): Promise<[validity: number, uid: number]> {
  const validity = (await session.select(folder)).uidValidity;
  if (validity === null) throw new Error("Missing UIDVALIDITY");
  const found = await session.uidSearch(`HEADER Message-ID ${quote(id)}`);
  if (!found.length) throw new Error("Saved draft UID is not yet available");
  const matching = (await session.uidFetch(found.join(","), "(UID BODY.PEEK[HEADER])")).flatMap(({ uid, header }) =>
    uid !== null && header && found.includes(uid) && parse(uid, header, true, false).messageId === id ? [uid] : [],
  );
  const [uid, ...others] = matching;
  if (uid === undefined || others.length) throw new Error("Saved draft identity is ambiguous or unavailable");
  return [validity, uid];
}

export async function append(session: Session, folder: string, raw: Uint8Array) {
  if (/[\r\n]/.test(folder)) throw new Error("Invalid Drafts folder name");
  await session.appendWithFlags(folder, raw, ["\\Draft", "\\Seen"]);
}
