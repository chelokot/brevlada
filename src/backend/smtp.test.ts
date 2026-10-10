import { expect, test } from "bun:test";
import type { Socket } from "bun";
import type { Account, Draft, SmtpSettings } from "../models";
import { parseMail } from "./mime";
import { parse } from "./parser";
import { draftMessage, message, send } from "./smtp";
import { certificate } from "./testing";

const bytes = (text: string) => new TextEncoder().encode(text);
const account: Account = { path: "", email: "me@example.com", name: "Me", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };
const reply: Draft = {
  attachmentsLoaded: true,
  to: "other@example.com",
  cc: "",
  subject: "Re: topic",
  text: "Reply",
  html: "<p>Reply</p>",
  attachments: [],
  attachmentNames: [],
  removedAttachments: [],
  attachmentSource: null,
  inReplyTo: "incoming@example.com",
  references: ["original@example.com", "incoming@example.com"],
};

test("sent reply round trips with thread headers", () => {
  const parsed = parse(0, bytes(message(account, reply, [reply.to], [])), true, true);
  expect(parsed.messageId).toContain("@example.com");
  expect(parsed.references).toEqual(["original@example.com", "incoming@example.com", "incoming@example.com"]);
  expect([parsed.bodyText.trim(), parsed.bodyHtml.trim(), parsed.sender]).toEqual(["Reply", "<p>Reply</p>", "Me <me@example.com>"]);
  const unfinished: Draft = {
    ...reply,
    to: "Other <unfinished",
    cc: "Copy <copy@example.com>",
    subject: "",
    text: "",
    attachments: ["Content-Type: application/octet-stream; name=report.bin\r\nContent-Disposition: attachment; filename=report.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8K\r\n"],
  };
  const raw = draftMessage(account, unfinished);
  const draft = parse(0, bytes(raw), true, true);
  expect([draft.recipients, draft.subject, draft.bodyText.trim(), draft.bodyHtml.trim(), draft.attachments]).toEqual([unfinished.to, "", "", "<p>Reply</p>", ["report.bin"]]);
  const mail = parseMail(bytes(raw));
  expect(mail.subparts[1] && mail.subparts[1].bodyRaw()).toEqual(new Uint8Array([0, 255, 10]));
  expect(mail.header("Cc")).toBe(unfinished.cc);
  expect(draft.references).toContain("incoming@example.com");
  expect(() => draftMessage(account, { ...unfinished, to: "other@example.com\r\nBcc: hidden@example.com" })).toThrow("Invalid recipient headers");
});

test("encodes long names and subjects as folded UTF-8 words and validates thread ids", () => {
  const raw = message({ ...account, name: "Jörg Ånström Łukasz Søren Müller Østergaard Kowalski" }, { ...reply, subject: "Grüße ".repeat(12), inReplyTo: null, references: [] }, ["a@example.com"], []);
  const [from = ""] = /^From: .*(?:\r\n .*)*/m.exec(raw) ?? [];
  const [subject = ""] = /^Subject: .*(?:\r\n .*)*/m.exec(raw) ?? [];
  expect(from.split("\r\n ").every((word) => /^(From: )?=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( <me@example.com>)?$/.test(word))).toBe(true);
  expect(subject.split("\r\n ").length).toBeGreaterThan(1);
  const parsed = parse(0, bytes(raw), true, false);
  expect([parsed.subject, parsed.sender]).toEqual(["Grüße ".repeat(12).trim(), "Jörg Ånström Łukasz Søren Müller Østergaard Kowalski <me@example.com>"]);
  expect(() => message(account, { ...reply, inReplyTo: "bad id" }, ["a@example.com"], [])).toThrow("Invalid reply message ID");
  expect(() => message(account, { ...reply, references: ["<a@b>", "c d"] }, ["a@example.com"], [])).toThrow("Invalid referenced message ID");
  expect(() => message(account, { ...reply, subject: "a\nb" }, ["a@example.com"], [])).toThrow("Invalid subject");
});

type Session = { buffer: string; data: string[] | null; upgraded: boolean };

async function sink(implicit: boolean, starttls = true) {
  const { cert, key } = await certificate();
  const commands: string[] = [];
  const messages: string[] = [];
  const respond = (socket: Socket<Session>, chunk: Buffer, write: (text: string) => void) => {
    const session = socket.data;
    session.buffer += chunk.toString();
    for (let end = session.buffer.indexOf("\r\n"); end >= 0; end = session.buffer.indexOf("\r\n")) {
      const line = session.buffer.slice(0, end);
      session.buffer = session.buffer.slice(end + 2);
      if (session.data) {
        if (line === ".") {
          messages.push(session.data.join("\r\n"));
          session.data = null;
          write("250 2.0.0 queued\r\n");
        } else session.data.push(line.startsWith(".") ? line.slice(1) : line);
        continue;
      }
      commands.push(line);
      if (line.startsWith("EHLO")) write(`250-sink\r\n${starttls && !implicit && !session.upgraded ? "250-STARTTLS\r\n" : ""}250 8BITMIME\r\n`);
      else if (line === "STARTTLS") {
        write("220 2.0.0 ready\r\n");
        session.upgraded = true;
        socket.upgradeTLS<Session>({ data: session, tls: { cert, key }, socket: { data: (secure, data) => respond(secure, data, (text) => void secure.write(text)) } });
      } else if (line.startsWith("RCPT") && line.includes("reject")) write("550 5.1.1 No such user\r\n");
      else if (line === "DATA") {
        session.data = [];
        write("354 go ahead\r\n");
      } else if (line === "QUIT") write("221 bye\r\n");
      else write("250 ok\r\n");
    }
  };
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    tls: implicit ? { cert, key } : undefined,
    socket: {
      open(socket) {
        socket.data = { buffer: "", data: null, upgraded: false };
        socket.write("220 sink ESMTP\r\n");
      },
      data(socket, chunk) {
        if (!socket.data.upgraded) respond(socket, chunk, (text) => void socket.write(text));
      },
    },
  });
  const settings: SmtpSettings = { host: "127.0.0.1", port: server.port, username: "", ssl: implicit, tls: !implicit, auth: false, login: false, plain: false, xoauth2: false };
  return { settings, commands, messages, stop: () => server.stop(true) };
}

const outgoing: Draft = {
  ...reply,
  to: "Other <other@example.com>, third@example.com",
  cc: "copy@example.com",
  subject: "Hello",
  text: "Body",
  html: null,
  inReplyTo: null,
  references: [],
  attachments: ["Content-Type: text/plain; name=dots.txt\r\nContent-Disposition: attachment; filename=dots.txt\r\n\r\n.hidden\r\n..twice\r\n"],
};

test("delivers over implicit TLS and STARTTLS with dot-stuffed data", async () => {
  for (const implicit of [true, false]) {
    const server = await sink(implicit);
    const sent = await send({ ...account, smtp: server.settings }, outgoing);
    expect(server.commands).toEqual([
      "EHLO localhost",
      ...(implicit ? [] : ["STARTTLS", "EHLO localhost"]),
      "MAIL FROM:<me@example.com>",
      "RCPT TO:<other@example.com>",
      "RCPT TO:<third@example.com>",
      "RCPT TO:<copy@example.com>",
      "DATA",
      "QUIT",
    ]);
    const [delivered = ""] = server.messages;
    expect(delivered).toContain("\r\n.hidden\r\n..twice\r\n");
    expect(parse(0, bytes(delivered), true, true)).toEqual(sent);
    expect([sent.subject, sent.recipients, sent.cc, sent.bodyText, sent.attachments]).toEqual(["Hello", "other@example.com, third@example.com", "copy@example.com", "Body", ["dots.txt"]]);
    server.stop();
  }
});

test("reports smtp rejections, missing STARTTLS and invalid drafts", async () => {
  const rejecting = await sink(false);
  await expect(send({ ...account, smtp: rejecting.settings }, { ...outgoing, cc: "reject@example.com" })).rejects.toThrow("SMTP server: 550 5.1.1 No such user");
  expect(rejecting.commands).not.toContain("DATA");
  rejecting.stop();
  const plain = await sink(false, false);
  await expect(send({ ...account, smtp: plain.settings }, outgoing)).rejects.toThrow("SMTP server does not support STARTTLS");
  plain.stop();
  const smtp = { ...plain.settings, port: 1 };
  for (const [changed, draft, error] of [
    [{ ...account, smtp: null }, outgoing, "Sending is unavailable for this account"],
    [{ ...account, smtp: { ...smtp, host: "" } }, outgoing, "SMTP server is not configured"],
    [{ ...account, smtp: { ...smtp, ssl: false, tls: false } }, outgoing, "SMTP encryption is not enabled in Online Accounts"],
    [{ ...account, smtp }, { ...outgoing, to: " " }, "Enter a recipient"],
    [{ ...account, smtp }, { ...outgoing, to: "Other <other@example.com" }, "Invalid email address"],
    [{ ...account, smtp }, { ...outgoing, to: "nobody" }, "Invalid email address"],
    [{ ...account, smtp }, { ...outgoing, text: " " }, "Enter a subject and message"],
    [{ ...account, smtp, email: "a@b.c, d@e.f" }, outgoing, "Account email address is invalid"],
    [{ ...account, smtp }, outgoing, "Could not connect to the SMTP server"],
  ] as const) {
    await expect(send(changed, draft)).rejects.toThrow(error);
  }
});
