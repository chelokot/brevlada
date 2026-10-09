import type { Message } from "../models";
import { asciiLower, sameAscii } from "../models/text";
import type { Mail } from "./mail";
import * as mailHeaders from "./mail-headers";

export interface Folders {
  all: string[];
  sync: string[];
  sent: string | null;
  drafts: string | null;
}

export interface Flags {
  uid: number;
  read: boolean;
  flagged: boolean;
  draft: boolean;
}

const DRAFTS = ["draft", "drafts"];
const SPAM = ["spam", "junk", "junk mail", "junk e-mail", "bulk mail"];
const EXCLUDED = new Set(["trash", "spam", "junk", "junk e-mail", "junk email", "deleted items", "deleted messages", "bin"]);

const namedFolder = (folder: string, names: string[]) =>
  names.includes(asciiLower(folder.slice(Math.max(folder.lastIndexOf("/"), folder.lastIndexOf(".")) + 1)));

export const hasSpecialUse = (attributes: string[], value: string) => attributes.some((attribute) => sameAscii(attribute, value));

export const isDraft = (folder: string, flags: string[], drafts: string | null) =>
  flags.includes("\\Draft") || drafts === folder || namedFolder(folder, DRAFTS);

export function applyFlags(message: Message, folder: string, flags: string[], drafts: string | null) {
  message.isFlagged = flags.includes("\\Flagged");
  message.isSpam = flags.some((flag) => sameAscii(flag, "$Junk")) || namedFolder(folder, SPAM);
  message.isDraft = isDraft(folder, flags, drafts);
  ensureDraftId(message, folder);
}

export function ensureDraftId(message: Message, folder: string) {
  if (message.isDraft && !message.messageId) message.messageId = `brevlada-draft:${folder}:${message.uid}`;
}

export function excludedFolder(name: string, attributes: string[]) {
  return (
    attributes.some((attribute) => sameAscii(attribute, "\\Trash") || sameAscii(attribute, "\\Junk")) ||
    name.split(/[/.]/).some((part) => EXCLUDED.has(part.toLowerCase()))
  );
}

export async function syncFolders(mail: Mail): Promise<Folders> {
  const listed = await mail.session.list(null, "*");
  const selectable = listed.filter((folder) => !folder.attributes.includes("\\Noselect"));
  const special = (attribute: string, names: string[]) => {
    const found = selectable.find((folder) => hasSpecialUse(folder.attributes, attribute)) ?? selectable.find((folder) => namedFolder(folder.name, names));
    return found ? found.name : null;
  };
  const sent = special("\\Sent", ["sent", "sent mail", "sent items", "sent messages"]);
  const drafts = special("\\Drafts", DRAFTS);
  mail.draftsFolder = drafts;
  const excluded = listed.filter((folder) => excludedFolder(folder.name, folder.attributes));
  const all = selectable.map((folder) => folder.name);
  const sync = all.filter(
    (name) => !excluded.some((parent) => name === parent.name || (parent.delimiter !== null && name.startsWith(parent.name + parent.delimiter))),
  );
  return { all: all.sort(), sync: sync.sort(), sent, drafts };
}

export async function inventory(mail: Mail, folder: string): Promise<[validity: number, flags: Flags[]]> {
  const { uidValidity, exists } = await mail.session.select(folder);
  if (uidValidity === null) throw new Error("Missing UIDVALIDITY");
  if (exists === 0) return [uidValidity, []];
  const fetched = await mail.session.uidFetch("1:*", "(UID FLAGS)");
  const flags = fetched.flatMap(({ uid, flags }) =>
    uid === null ? [] : [{ uid, read: flags.includes("\\Seen"), flagged: flags.includes("\\Flagged"), draft: isDraft(folder, flags, mail.draftsFolder) }],
  );
  return [uidValidity, flags];
}

export async function headerBatch(mail: Mail, folder: string, validity: number, uids: number[]) {
  if ((await mail.session.select(folder)).uidValidity !== validity) throw new Error("Mailbox changed during sync");
  return mailHeaders.fetch(mail.session, folder, mail.draftsFolder, validity, uids);
}

export const cachedBody = (mail: Mail, folder: string, validity: number, uid: number) => mail.bodyWithValidity(folder, uid, validity, false);
