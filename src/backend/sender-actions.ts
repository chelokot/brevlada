import type { Account, Message } from "../models";
import type { ActionTarget } from "../models/action-target";
import { flaggedState, readState, removesMessages, type SenderAction } from "../models/sender-action";
import { key } from "../models/senders";
import { Mail } from "./mail";
import * as mailHeaders from "./mail-headers";
import { hasSpecialUse, headerBatch, inventory } from "./mail-sync";
import { attempt, failure, type Emit } from "./protocol";
import type { Storage } from "./storage";

type Session = Mail["session"];

export interface Outcome {
  messages: Message[] | null;
  error: string | null;
  removed: Message[];
}

export interface UndoOutcome {
  messages: Message[] | null;
  restored: Message[];
  error: string | null;
}

const CHUNK = 200;

const chunks = (uids: number[]) => Array.from({ length: Math.ceil(uids.length / CHUNK) }, (_, index) => uids.slice(index * CHUNK, (index + 1) * CHUNK));

function cachedHeaders(storage: Storage, account: string, folder: string) {
  try {
    return storage.senderHeaders(account, folder);
  } catch {
    return null;
  }
}

export async function execute(account: Account, folder: string, target: ActionTarget, action: SenderAction, storage: Storage, emit: Emit): Promise<Outcome> {
  await using mail = await Mail.connect(account);
  const validity = target.kind === "Messages" ? storage.validity(account.email, folder) : null;
  const result = await attempt(() =>
    target.kind === "Sender" ? apply(mail.session, folder, target.sender, action) : applyMessages(mail, folder, validity, target.messages, action),
  );
  let error = result.ok ? null : result.error;
  try {
    if (result.ok) storage.confirmAction(account.email, folder, result.value, action);
  } catch (problem) {
    error = `Action completed, but the mail cache could not update: ${failure(problem)}`;
  }
  const removed = result.ok && removesMessages(action) ? result.value : [];
  const refresh = await attempt(async () => {
    const revision = storage.readRevision();
    const [validity, flags] = await inventory(mail, folder);
    storage.inventorySince(account.email, folder, validity, flags, revision);
    emit({ type: "Unread", account: account.email, folders: [[folder, flags.some((flag) => !flag.read)]] });
    return storage.senderHeaders(account.email, folder);
  });
  if (refresh.ok) return { messages: refresh.value, error, removed };
  error ??= result.ok ? `Action completed, but the message list could not refresh: ${refresh.error}` : refresh.error;
  return { messages: cachedHeaders(storage, account.email, folder), error, removed };
}

export async function undoSpam(account: Account, folder: string, originals: Message[], storage: Storage, emit: Emit): Promise<UndoOutcome> {
  await using mail = await Mail.connect(account);
  const spam = await destination(mail.session, { kind: "Spam" });
  const restored: Message[] = [];
  let error: string | null = null;
  for (const original of originals) {
    const result = await attempt(() => undoMessage(mail.session, spam, folder, original));
    if (!result.ok) {
      error = result.error;
      break;
    }
    restored.push(original);
    try {
      storage.confirmAction(account.email, spam, [result.value], { kind: "MoveTo", folder });
    } catch (problem) {
      error = `Message restored, but the mail cache could not update: ${failure(problem)}`;
    }
  }
  const refresh = await attempt(async () => {
    const revision = storage.readRevision();
    const [validity, flags] = await inventory(mail, folder);
    const missing = storage.inventorySince(account.email, folder, validity, flags, revision);
    for (const chunk of chunks(missing)) storage.storeHeaders(account.email, folder, validity, await headerBatch(mail, folder, validity, chunk));
    emit({ type: "Unread", account: account.email, folders: storage.unread(account.email) });
    return storage.senderHeaders(account.email, folder);
  });
  if (refresh.ok) return { messages: refresh.value, restored, error };
  return { messages: cachedHeaders(storage, account.email, folder), restored, error: error ?? `Could not refresh restored messages: ${refresh.error}` };
}

export async function undoMessage(session: Session, spam: string, destination: string, original: Message) {
  const sender = key(original);
  if (!original.messageId && !sender) throw new Error("Could not identify this message in Spam");
  const query = original.messageId ? `HEADER Message-ID ${quoted(original.messageId)}` : `FROM ${quoted(sender)}`;
  const { uidValidity: validity } = await session.select(spam);
  if (validity === null) throw new Error("Missing Spam UIDVALIDITY");
  const matches: Message[] = [];
  for (const chunk of chunks([...(await session.uidSearch(query))])) {
    const headers = await mailHeaders.fetch(session, spam, null, validity, chunk);
    matches.push(
      ...headers.filter(
        (message) =>
          message.messageId === original.messageId &&
          key(message) === sender &&
          message.subject === original.subject &&
          message.timestamp === original.timestamp,
      ),
    );
  }
  const [message] = matches;
  if (matches.length !== 1 || !message) throw new Error("Could not uniquely identify this message in Spam; open the Spam folder to restore it");
  const sequence = String(message.uid);
  if ((await session.select(spam)).uidValidity !== validity) throw new Error("Spam mailbox changed; refresh and retry");
  await session.uidStore(sequence, "-FLAGS.SILENT ($Junk)");
  await session.uidStore(sequence, "+FLAGS.SILENT ($NotJunk)");
  if (!(await applyUids(session, spam, validity, [message.uid], { kind: "MoveTo", folder: destination })))
    throw new Error("Message is already in the destination folder");
  return message;
}

export async function apply(session: Session, folder: string, sender: string, action: SenderAction) {
  if (!sender) throw new Error("Sender has no email address");
  if (/\p{Cc}/u.test(sender)) throw new Error("Sender address contains invalid characters");
  const { uidValidity: validity } = await session.select(folder);
  if (validity === null) throw new Error("Missing UIDVALIDITY");
  const messages: Message[] = [];
  for (const chunk of chunks([...(await session.uidSearch(`FROM ${quoted(sender)}`))])) {
    messages.push(...(await mailHeaders.fetch(session, folder, null, validity, chunk)).filter((message) => key(message) === sender));
  }
  return (await applyUids(
    session,
    folder,
    validity,
    messages.map((message) => message.uid),
    action,
  ))
    ? messages
    : [];
}

async function applyMessages(mail: Mail, folder: string, validity: number | null, messages: [uid: number, messageId: string][], action: SenderAction) {
  if (validity === null) throw new Error("Mailbox is not ready; refresh and retry");
  const verified: Message[] = [];
  for (const chunk of chunks(messages.map(([uid]) => uid))) {
    for (const header of await headerBatch(mail, folder, validity, chunk)) {
      if (!messages.some(([uid, id]) => uid === header.uid && id === header.messageId)) throw new Error("Message changed on the server; refresh and retry");
      verified.push(header);
    }
  }
  return (await applyUids(
    mail.session,
    folder,
    validity,
    verified.map((message) => message.uid),
    action,
  ))
    ? verified
    : [];
}

export async function applyUids(session: Session, folder: string, validity: number, uids: number[], action: SenderAction) {
  if (!uids.length) return false;
  const read = readState(action);
  const flagged = flaggedState(action);
  const selected = async () => {
    if ((await session.select(folder)).uidValidity !== validity) throw new Error("Mailbox changed during sender action; please retry");
  };
  if (read !== null || flagged !== null) {
    const change = read !== null ? `${read ? "+" : "-"}FLAGS.SILENT (\\Seen)` : `${flagged ? "+" : "-"}FLAGS.SILENT (\\Flagged)`;
    await selected();
    for (const chunk of chunks(uids)) await session.uidStore(chunk.join(","), change);
    return true;
  }
  const target = await destination(session, action);
  const capabilities = await session.capabilities();
  const [canMove, canExpunge] = [capabilities.has("MOVE"), capabilities.has("UIDPLUS")];
  if (target === folder && action.kind !== "Delete") return false;
  if (!((canMove && target !== folder) || canExpunge)) throw new Error("Mail server needs MOVE or UIDPLUS support to safely remove these messages");
  await selected();
  for (const chunk of chunks(uids)) {
    const sequence = chunk.join(",");
    if (action.kind === "Unspam") {
      await session.uidStore(sequence, "-FLAGS.SILENT ($Junk)");
      await session.uidStore(sequence, "+FLAGS.SILENT ($NotJunk)");
    }
    if (action.kind === "Spam") {
      await session.uidStore(sequence, "-FLAGS.SILENT ($NotJunk)");
      await session.uidStore(sequence, "+FLAGS.SILENT ($Junk)");
    }
    if (target !== folder && canMove) await session.uidMv(sequence, target);
    else {
      if (target !== folder) await session.uidCopy(sequence, quoted(target));
      await session.uidStore(sequence, "+FLAGS.SILENT (\\Deleted)");
      await session.uidExpunge(sequence);
    }
  }
  return true;
}

function quoted(value: string) {
  if (/\p{Cc}/u.test(value)) throw new Error("Message headers contain invalid characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function destination(session: Session, action: SenderAction) {
  if (action.kind === "Restore" || action.kind === "Unspam") return "INBOX";
  const selectable = (await session.list(null, "*")).filter((folder) => !folder.attributes.includes("\\Noselect"));
  if (action.kind === "MoveTo") {
    if (!selectable.some((folder) => folder.name === action.folder)) throw new Error("Destination folder is not selectable; refresh and retry");
    return action.folder;
  }
  const marked = (attribute: string) => selectable.find((folder) => hasSpecialUse(folder.attributes, attribute));
  const found =
    marked(action.kind === "Archive" ? "\\Archive" : action.kind === "Spam" ? "\\Junk" : "\\Trash") ??
    (action.kind === "Archive" ? marked("\\All") : undefined) ??
    selectable.find(({ name, delimiter }) => fallbackFolder(delimiter === null ? name : name.slice(name.lastIndexOf(delimiter) + 1), action));
  if (found) return found.name;
  throw new Error(`Could not find the account's ${action.kind === "Archive" ? "Archive" : action.kind === "Spam" ? "Spam" : "Trash"} folder`);
}

export function fallbackFolder(name: string, action: SenderAction) {
  const names =
    action.kind === "Archive"
      ? ["archive", "archives", "all mail"]
      : action.kind === "Spam"
        ? ["spam", "junk", "junk mail", "junk e-mail", "bulk", "bulk mail"]
        : ["trash", "bin", "deleted items", "deleted messages"];
  return names.includes(name.toLowerCase());
}
