import type { Account, Message } from "../models";
import { safeName } from "../models/attachment";
import { quote } from "./imap";
import { Mail } from "./mail";
import { syncFolders } from "./mail-sync";
import { attachmentName, base64Lines, parseMail, type Part } from "./mime";
import { parse } from "./parser";

export const MAX_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();

export function validate(parts: string[]) {
  let total = 0;
  for (const part of parts) {
    total += parseMail(encoder.encode(part)).bodyRaw().length;
    if (total > MAX_BYTES) throw new Error("Attachments exceed the 20 MB total limit");
  }
}

export function encode(name: string, mime: string, bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES) throw new Error("Attachments must be smaller than 20 MB");
  if (!mime.includes("/") || !/^[A-Za-z0-9/!#$&^_.+-]*$/.test(mime)) throw new Error("Invalid attachment content type");
  const encoded = Array.from(encoder.encode(safeName(name)), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  const filename = (encoded.match(/.{1,54}/g) ?? []).map((chunk, index) => ` filename*${index}*=${index ? "" : "UTF-8''"}${chunk}`).join(";\r\n");
  return `Content-Type: ${mime}\r\nContent-Disposition: attachment;\r\n${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(bytes)}`;
}

export async function download(account: Account, folder: string, message: Message, index: number): Promise<Uint8Array> {
  await using mail = await Mail.connect(account);
  const source = folder || (await syncFolders(mail)).sent;
  if (source === null) throw new Error("This account has no Sent folder");
  const mailbox = await mail.session.examine(source);
  if (message.uidValidity !== null && mailbox.uidValidity !== message.uidValidity) throw new Error("Mailbox changed; reload the message");
  let uid = message.uid;
  if (uid === 0) {
    if (!message.messageId || /\p{Cc}/u.test(message.messageId)) throw new Error("Message identity is unavailable");
    const [found, ...others] = await mail.session.uidSearch(`HEADER Message-ID ${quote(message.messageId)}`);
    if (found === undefined || others.length) throw new Error("Sent message is missing or ambiguous; refresh the Sent folder");
    uid = found;
  }
  const item = (await mail.session.uidFetch(String(uid), "(UID BODY.PEEK[])")).find((item) => item.uid === uid);
  if (!item || !item.body) throw new Error("Message is no longer on the server");
  return decode(message, item.body, index);
}

export function decode(message: Message, raw: Uint8Array, index: number): Uint8Array {
  if (parse(message.uid, raw, true, false).messageId !== message.messageId) throw new Error("Message changed; reload it before saving attachments");
  const part = collect(parseMail(raw))[index];
  if (!part) throw new Error("Attachment is no longer available");
  if (attachmentName(part) !== message.attachments[index]) throw new Error("Attachment changed; reload the message");
  return part.bodyRaw();
}

const collect = (mail: Part): Part[] => (attachmentName(mail) === null ? mail.subparts.flatMap(collect) : [mail]);
