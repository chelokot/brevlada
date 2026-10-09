import { expect, test } from "bun:test";
import { listHeader, prepareDisplay, type Message } from "../models";
import { renderedCalendar } from "../models/attachment";
import { normalizeMessageId, parse } from "./parser";

const bytes = (text: string) => new TextEncoder().encode(text);

test("ticket payloads survive caching and old bodies are hydrated", () => {
  const raw = `Content-Type: text/html\r\n\r\n<script type='application/ld+json'>{"@type":"TrainReservation","reservationNumber":"one","reservationFor":{"@type":"TrainTrip","name":"Express","departureTime":"2026-10-08T13:00:00+02:00"},"reservedTicket":{"@type":"Ticket","ticketNumber":"two"}}</script>`;
  const message = parse(1, bytes(raw), false, true);
  expect(message.tickets).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(message)).tickets).toEqual(message.tickets);
  const legacy: Message = { ...message, tickets: [] };
  prepareDisplay(legacy);
  expect(legacy.tickets).toEqual(message.tickets);
  expect(listHeader(legacy, true).tickets).toEqual(message.tickets);
  prepareDisplay(legacy);
  expect(legacy.tickets).toHaveLength(1);
});

test("lists unnamed and explicit inline attachments without treating them as body", () => {
  const raw =
    "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHello\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment\r\n\r\nAttached text\r\n" +
    "--x\r\nContent-Type: image/png; name=logo.png\r\nContent-ID: <logo>\r\n\r\nPNG\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=photo.png\r\nContent-ID: <photo>\r\n\r\nPHOTO\r\n--x--\r\n";
  const message = parse(3, bytes(raw), false, true, true);
  expect(message.bodyText.trim()).toBe("Hello");
  expect(message.attachments).toEqual(["Unnamed attachment", "photo.png"]);
  expect(message.attachmentDetails.map(({ mime, size }) => [mime, size])).toEqual([
    ["text/plain", 13],
    ["image/png", 5],
  ]);
});

test("decodes multipart bodies and attachment names", () => {
  const raw =
    "From: =?UTF-8?Q?J=C3=B6rg?= <j@example.com>\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nMessage-ID: <one>\r\nReferences: <parent>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n" +
    "--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>Hello</b>\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=report.pdf\r\n\r\nPDF\r\n--x--\r\n";
  const message = parse(7, bytes(raw), false, true);
  expect(message.subject).toBe("Grüße");
  expect(message.sender).toContain("Jörg");
  expect(message.bodyText.trim()).toBe("Hello");
  expect(message.bodyHtml).toContain("<b>Hello</b>");
  expect(message.attachments).toEqual(["report.pdf"]);
  expect(message.references).toEqual(["parent"]);
  expect(message.bodyLoaded).toBe(true);
});

const invitation = (uid: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T120000Z\r\nDTSTART:20261002T120000Z\r\nSUMMARY:${uid}\r\nORGANIZER:mailto:host@example.com\r\nATTENDEE:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test("extracts calendar parts before attachment handling", () => {
  const calendar = bytes("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting@example.com\r\nDTSTART:20261002T120000Z\r\nSUMMARY:Lunch\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").toBase64();
  for (const mime of ["text/calendar; method=REQUEST", "application/octet-stream"]) {
    const raw = `Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nInvitation\r\n--x\r\nContent-Type: ${mime}\r\nContent-Disposition: attachment; filename=invite.ics\r\nContent-Transfer-Encoding: base64\r\n\r\n${calendar}\r\n--x--\r\n`;
    const message = parse(7, bytes(raw), false, true);
    expect(message.attachments).toEqual(["invite.ics"]);
    expect(message.calendarEvents).toHaveLength(1);
    expect(renderedCalendar(message, 0)).toBe(true);
    expect(message.calendarEvents[0]).toMatchObject({ name: "Lunch", invitation: true });
    expect(parse(7, bytes(raw), false, false).calendarEvents).toEqual([]);
  }
});

test("multiple invitations keep other attachment indices", () => {
  const parts = ["first", "second"].map(
    (uid) => `--x\r\nContent-Type: text/calendar; method=REQUEST\r\nContent-Disposition: attachment; filename=${uid}.ics\r\n\r\n${invitation(uid)}${uid === "first" ? "--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=notes.txt\r\n\r\nNotes\r\n" : ""}`,
  );
  const raw = `Content-Type: multipart/mixed; boundary=x\r\n\r\n${parts.join("")}--x\r\nContent-Type: text/calendar\r\nContent-Disposition: attachment; filename=invalid.ics\r\n\r\nInvalid calendar\r\n--x--\r\n`;
  const message = parse(1, bytes(raw), false, true);
  expect(message.calendarEvents).toHaveLength(2);
  expect(message.attachments).toEqual(["first.ics", "notes.txt", "second.ics", "invalid.ics"]);
  expect([0, 1, 2, 3].map((index) => renderedCalendar(message, index))).toEqual([true, false, true, false]);
});

test("headers remain lazy", () => {
  const message = parse(9, bytes("Subject: Test\r\n\r\n"), true, false);
  expect(message.bodyLoaded).toBe(false);
  expect(message.isRead).toBe(true);
});

test("retains decoded reply-to and cc in headers and bodies", () => {
  const raw = "From: Sender <sender@example.com>\r\nReply-To: =?UTF-8?Q?J=C3=B6rg?= <support@example.com>,\r\n backup@example.com\r\nCc: copy@example.com\r\n\r\nHello";
  for (const bodyLoaded of [false, true]) {
    const message = parse(9, bytes(raw), false, bodyLoaded);
    expect(message.replyTo).toBe("Jörg <support@example.com>, backup@example.com");
    expect(message.cc).toBe("copy@example.com");
  }
});

test("reads unsubscribe headers without loading body", () => {
  const raw = "List-Unsubscribe: <mailto:leave@example.org>, <https://example.org/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n";
  const message = parse(4, bytes(raw), false, false);
  expect(message.unsubscribe).toEqual({ url: "https://example.org/u/1", oneClick: true });
  expect(message.bodyLoaded).toBe(false);
});

test("keeps browser and mailto unsubscribe links without one-click", () => {
  for (const [headers, url] of [
    ["List-Unsubscribe: <https://example.org/preferences>", "https://example.org/preferences"],
    ["List-Unsubscribe: <https://example.org/preferences>\r\nList-Unsubscribe-Post: something-else", "https://example.org/preferences"],
    ["List-Unsubscribe: <mailto:leave@example.org>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click", "mailto:leave@example.org"],
  ] as const) {
    expect(parse(4, bytes(`${headers}\r\n\r\n`), false, false).unsubscribe).toEqual({ url, oneClick: false });
  }
});

test("distinguishes legacy cached unsubscribe links from get links", () => {
  expect(parse(4, bytes("List-Unsubscribe: <https://example.org/u/1>\r\n\r\n"), false, false).unsubscribe).toEqual({ url: "https://example.org/u/1", oneClick: false });
  expect(parse(4, bytes("List-Unsubscribe: <ftp://example.org/u/1>, <>\r\n\r\n"), false, false).unsubscribe).toBeNull();
});

test("keeps inline cid images from multipart mail", () => {
  const raw =
    "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<img src='cid:logo@example.org'>\r\n" +
    "--x\r\nContent-Type: image/png\r\nContent-ID: <Logo@Example.org>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--\r\n";
  const message = parse(3, bytes(raw), false, true, true);
  expect(message.inlineMediaLoaded).toBe(true);
  expect(message.inlineMedia).toEqual([{ contentId: "logo@example.org", mime: "image/png", data: "aGVsbG8=" }]);
  const background = parse(3, bytes(raw), false, true);
  expect(background.inlineMediaLoaded).toBe(false);
  expect(background.inlineMedia).toEqual([]);
});

test("normalizes folded message ids consistently", () => {
  const header = parse(66, bytes("Message-ID: <same@example.com>\r\n\r\n"), false, false);
  const body = parse(66, bytes("Message-ID: \r\n <same@example.com>\r\n\r\nHello"), false, true);
  expect(header.messageId).toBe("same@example.com");
  expect(body.messageId).toBe(header.messageId);
  expect(normalizeMessageId(" <same@example.com> ")).toBe(header.messageId);
  expect(normalizeMessageId("<other@example.com>")).not.toBe(header.messageId);
});

test("parses dates, references and in-reply-to like the Rust cache expects", () => {
  const message = parse(5, bytes("Date: Thu, 8 Oct 2026 13:00:00 +0200\r\nReferences: <<a>> <b>\r\nIn-Reply-To:  <c> \r\n\r\n"), false, false);
  expect(message.timestamp).toBe(Date.UTC(2026, 9, 8, 11) / 1000);
  expect(message.references).toEqual(["a", "b", "c"]);
  expect(message.inReplyTo).toBe("c");
  expect(parse(5, bytes("Date: yesterday\r\n\r\n"), false, false).timestamp).toBe(0);
});
