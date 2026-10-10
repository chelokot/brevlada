import type { Account, Draft, Message, SmtpSettings } from "../models";
import { parse as parseAddresses } from "../models/address";
import { smtpPassword, token } from "./accounts";
import { validate } from "./attachments";
import { base64Lines, trim } from "./mime";
import { normalizeMessageId, parse } from "./parser";
import { Stream } from "./stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64 = (value: string) => encoder.encode(value).toBase64();

class Client {
  constructor(readonly stream: Stream) {}

  async response(expected: number): Promise<string> {
    let response = "";
    for (;;) {
      const bytes = await this.stream.line();
      if (!bytes) throw new Error("SMTP server closed the connection");
      const line = decoder.decode(bytes);
      if (line.length < 4) throw new Error("Invalid SMTP response");
      if (!/^\d{3}$/.test(line.slice(0, 3))) throw new Error("Invalid SMTP status");
      const code = Number(line.slice(0, 3));
      response += line;
      if (line[3] === " ") {
        if (code === expected || (expected === 250 && code === 251)) return response;
        throw new Error(`SMTP server: ${trim(response)}`);
      }
      if (line[3] !== "-") throw new Error("Invalid SMTP response");
    }
  }

  async command(line: string, expected: number) {
    await this.stream.write(`${line}\r\n`);
    return this.response(expected);
  }

  async writeData(data: string) {
    await this.stream.write(`${data
      .split("\r\n")
      .map((line) => `${line.startsWith(".") ? "." : ""}${line}\r\n`)
      .join("")}.\r\n`);
    await this.response(250);
  }
}

export async function send(account: Account, draft: Draft): Promise<Message> {
  validate(draft.attachments);
  const settings = account.smtp;
  if (!settings) throw new Error("Sending is unavailable for this account");
  if (!settings.host) throw new Error("SMTP server is not configured");
  if (!settings.ssl && !settings.tls) throw new Error("SMTP encryption is not enabled in Online Accounts");
  const to = addresses(draft.to);
  if (!to.length) throw new Error("Enter a recipient");
  const cc = addresses(draft.cc);
  const [from, ...extra] = addresses(account.email);
  if (from === undefined || extra.length) throw new Error("Account email address is invalid");
  if (!trim(draft.subject) || !trim(draft.text)) throw new Error("Enter a subject and message");
  const raw = message(account, draft, to, cc);
  const stream = await Stream.connect(settings.host, settings.port).catch(() => {
    throw new Error("Could not connect to the SMTP server");
  });
  try {
    const client = new Client(stream);
    if (settings.ssl) await stream.upgrade(settings.host);
    await client.response(220);
    if (!settings.ssl) {
      const greeting = await client.command("EHLO localhost", 250);
      if (!greeting.toUpperCase().includes("STARTTLS")) throw new Error("SMTP server does not support STARTTLS");
      await client.command("STARTTLS", 220);
      await stream.upgrade(settings.host);
    }
    await deliver(client, account, settings, from, [...to, ...cc], raw);
  } finally {
    stream.close();
  }
  return parse(0, encoder.encode(raw), true, true);
}

async function deliver(client: Client, account: Account, settings: SmtpSettings, from: string, recipients: string[], message: string) {
  await client.command("EHLO localhost", 250);
  if (settings.auth) {
    const username = settings.username || account.email;
    if (settings.xoauth2) await client.command(`AUTH XOAUTH2 ${base64(`user=${username}\x01auth=Bearer ${token(account)}\x01\x01`)}`, 235);
    else {
      const password = smtpPassword(account);
      if (settings.plain) await client.command(`AUTH PLAIN ${base64(`\0${username}\0${password}`)}`, 235);
      else if (settings.login) {
        await client.command("AUTH LOGIN", 334);
        await client.command(base64(username), 334);
        await client.command(base64(password), 235);
      } else throw new Error("SMTP account has no supported authentication method");
    }
  }
  await client.command(`MAIL FROM:<${from}>`, 250);
  for (const recipient of recipients) await client.command(`RCPT TO:<${recipient}>`, 250);
  await client.command("DATA", 354);
  await client.writeData(message);
  await client.command("QUIT", 221).catch(() => {});
}

function addresses(input: string): string[] {
  if (!trim(input)) return [];
  const parsed = parseAddresses(input);
  if (!parsed) throw new Error("Invalid email address");
  const result = parsed.flat().map(({ addr }) => addr);
  const invalid = result.find((address) => !address.includes("@") || /[\p{Cc}\p{White_Space}<>:,;]/u.test(address));
  if (invalid !== undefined) throw new Error(`Invalid email address: ${invalid}`);
  return result;
}

function encoded(value: string) {
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (size + length > 42) {
      words.push(`=?UTF-8?B?${base64(chunk)}?=`);
      [chunk, size] = ["", 0];
    }
    chunk += character;
    size += length;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join("\r\n ");
}

const part = (type: string, body: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(encoder.encode(body))}`;

const nanoseconds = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;

export function draftMessage(account: Account, draft: Draft) {
  if (addresses(account.email).length !== 1) throw new Error("Account email address is invalid");
  if (/[\r\n]/.test(draft.to + draft.cc)) throw new Error("Invalid recipient headers");
  return message(account, draft, [draft.to], draft.cc ? [draft.cc] : []);
}

export function message(account: Account, draft: Draft, to: string[], cc: string[]) {
  if (/[\r\n]/.test(draft.subject)) throw new Error("Invalid subject");
  const from = account.email;
  const sender = trim(account.name) ? `${encoded(account.name)} <${from}>` : from;
  let output = `From: ${sender}\r\nTo: ${to.join(", ")}\r\n`;
  if (cc.length) output += `Cc: ${cc.join(", ")}\r\n`;
  if (!from.includes("@")) throw new Error("Account email address is invalid");
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const date = new Date().toUTCString().replace(/ 0(\d) /, " $1 ").replace("GMT", "+0000");
  output += `Subject: ${encoded(trim(draft.subject))}\r\nDate: ${date}\r\nMessage-ID: <${nanoseconds()}.${process.pid}@${domain}>\r\nMIME-Version: 1.0\r\n`;
  if (draft.inReplyTo !== null) {
    const reply = normalizeMessageId(draft.inReplyTo);
    if (!validMessageId(reply)) throw new Error("Invalid reply message ID");
    output += `In-Reply-To: <${reply}>\r\n`;
  }
  if (draft.references.length) {
    const references = draft.references.map(normalizeMessageId);
    if (!references.every(validMessageId)) throw new Error("Invalid referenced message ID");
    output += `References: ${[...new Set(references)].map((id) => `<${id}>`).join(" ")}\r\n`;
  }
  if (draft.html !== null) {
    const boundary = `brevlada-${process.pid}-${nanoseconds()}`;
    output += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${part("text/plain", draft.text)}--${boundary}\r\n${part("text/html", draft.html)}--${boundary}--\r\n`;
  } else output += part("text/plain", draft.text);
  if (draft.attachments.length) {
    const boundary = `brevlada-mixed-${process.pid}-${nanoseconds()}`;
    const split = output.indexOf("\r\nContent-Type:");
    if (split < 0) throw new Error("Missing message content type");
    const attachments = draft.attachments.map((attachment) => `--${boundary}\r\n${attachment}`).join("");
    output = `${output.slice(0, split)}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${output.slice(split + 2)}${attachments}--${boundary}--\r\n`;
  }
  return output;
}

const validMessageId = (value: string) => /^[^\p{White_Space}\p{Cc}<>]+$/u.test(value);
