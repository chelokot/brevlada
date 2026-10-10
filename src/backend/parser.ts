import { message as createMessage, type Message, type Unsubscribe } from "../models";
import { events, parseIcal } from "../models/calendar";
import { asciiLower } from "../models/text";
import { parse as tickets } from "../models/ticket";
import { attachmentName, dateparse, parseMail, trim, type Part } from "./mime";

const brackets = /^[<>]+|[<>]+$/g;
const images = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function parse(uid: number, bytes: Uint8Array, isRead: boolean, bodyLoaded: boolean, inline = false): Message {
  const mail = parseMail(bytes);
  const header = (name: string) => mail.header(name) ?? "";
  const date = header("Date");
  const inReplyTo = normalizeMessageId(header("In-Reply-To"));
  const message = createMessage({
    uid,
    messageId: normalizeMessageId(header("Message-ID")),
    subject: header("Subject"),
    sender: header("From"),
    replyTo: header("Reply-To"),
    recipients: header("To"),
    cc: header("Cc"),
    inReplyTo: inReplyTo || null,
    timestamp: timestamp(date),
    date,
    references: `${header("References")} ${header("In-Reply-To")}`
      .split(/\p{White_Space}+/u)
      .filter((reference) => reference)
      .map((reference) => reference.replace(brackets, "")),
    isRead,
    bodyLoaded,
    unsubscribe: unsubscribe(header("List-Unsubscribe"), header("List-Unsubscribe-Post")),
  });
  if (bodyLoaded) {
    message.inlineMediaLoaded = inline;
    bodies(mail, message, inline);
    message.calendarEvents = events(message);
    message.tickets = tickets(message.bodyHtml);
  }
  return message;
}

export const normalizeMessageId = (value: string) => trim(trim(value).replace(brackets, ""));

function timestamp(date: string) {
  try {
    return dateparse(date);
  } catch {
    return 0;
  }
}

function unsubscribe(value: string, post: string): Unsubscribe | null {
  const links = value.split(",").flatMap((part) => {
    const [, link] = /^<(.*)>$/s.exec(trim(part)) ?? [];
    return link === undefined ? [] : [link];
  });
  const url = links.find((link) => link.startsWith("https://")) ?? links.find((link) => link.startsWith("mailto:"));
  return url === undefined ? null : { url, oneClick: url.startsWith("https://") && trim(post) === "List-Unsubscribe=One-Click" };
}

function bodies(mail: Part, message: Message, inline: boolean) {
  const { mimetype, params } = mail.ctype;
  if (inline && images.includes(mimetype)) {
    const contentId = asciiLower(trim(mail.header("Content-ID") ?? "").replace(brackets, ""));
    if (contentId) {
      const bytes = mail.bodyRaw();
      const current = message.inlineMedia.reduce((total, part) => total + part.data.length, 0);
      if (current + Math.floor((bytes.length * 4) / 3) <= 8 * 1024 * 1024) message.inlineMedia.push({ contentId, mime: mimetype, data: bytes.toBase64() });
    }
  }
  let calendarRendered = false;
  const names = [params.get("name"), mail.disposition().params.get("filename")];
  if (mimetype === "text/calendar" || mimetype === "application/ics" || names.some((name) => name !== undefined && asciiLower(name).endsWith(".ics"))) {
    const found = parseIcal(mail.body());
    calendarRendered = found.length > 0;
    message.calendarEvents.push(...found);
  }
  const name = attachmentName(mail);
  if (name !== null) {
    message.attachments.push(name);
    message.attachmentDetails.push({ mime: mimetype, size: mail.bodyRaw().length, calendarRendered });
  } else if (mail.subparts.length) for (const part of mail.subparts) bodies(part, message, inline);
  else if (mimetype === "text/html") message.bodyHtml += mail.body();
  else if (mimetype === "text/plain") message.bodyText += (message.bodyText ? "\n" : "") + mail.body();
}
