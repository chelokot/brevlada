import { TextDecoder } from "node:util";
import { attachmentName, dateparse, parseMail, type Part } from "../src/backend/mime";

let seed = 42;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const between = (low: number, high: number) => low + Math.floor(random() * (high - low));
const pick = <T>(items: readonly T[]): T => {
  const chosen = between(0, items.length);
  return items.reduce((result, item, index) => (index === chosen ? item : result));
};

function legacy(label: string, pairs: [number, number, number, number] | null, enter: number[] = [], leave: number[] = []) {
  const decoder = new TextDecoder(label, { fatal: true });
  const table = new Map<string, number[]>();
  const visit = (bytes: number[]) => {
    try {
      const text = decoder.decode(Uint8Array.from([...enter, ...bytes, ...leave]));
      if (text.length === 1 && !table.has(text)) table.set(text, [...enter, ...bytes, ...leave]);
    } catch {}
  };
  if (pairs) for (let first = pairs[0]; first <= pairs[1]; first++) for (let second = pairs[2]; second <= pairs[3]; second++) visit([first, second]);
  else for (let byte = 0x80; byte <= 0xff; byte++) visit([byte]);
  return (text: string) => Uint8Array.from([...text].flatMap((character) => (character < "\x80" ? [character.charCodeAt(0)] : (table.get(character) ?? [63]))));
}

const charsets: Record<string, { encode: (text: string) => Uint8Array; words: string[] }> = {
  "windows-1251": { encode: legacy("windows-1251", null), words: "привет письмо встреча отчёт неделя проект договор счёт доставка заказ скидка новости".split(" ") },
  "koi8-r": { encode: legacy("koi8-r", null), words: "здравствуйте рассылка подписка обновление магазин посылка курьер".split(" ") },
  "iso-8859-1": { encode: legacy("iso-8859-1", null), words: "Grüße Bestätigung Lieferung Rechnung Mädchen Größe Übersicht für Café".split(" ") },
  gbk: { encode: legacy("gbk", [0x81, 0xfe, 0x40, 0xfe]), words: "你好 订单 发货 会议 报告 新闻 优惠 通知 账单 快递".split(" ") },
  "iso-2022-jp": { encode: legacy("iso-2022-jp", [0x21, 0x7e, 0x21, 0x7e], [0x1b, 0x24, 0x42], [0x1b, 0x28, 0x42]), words: "こんにちは 注文 発送 会議 報告 お知らせ 請求書 配達".split(" ") },
};
const english = "the a of newsletter update your order shipped meeting tomorrow please review attached report weekly digest offer sale".split(" ");
const sentence = (words: string[], count: number) => Array.from({ length: count }, () => pick(words)).join(" ");
const encoder = new TextEncoder();

function qp(bytes: Uint8Array) {
  let line = "";
  let output = "";
  for (const byte of bytes) {
    if (byte === 10) {
      output += `${line}\r\n`;
      line = "";
      continue;
    }
    const token = byte === 13 ? "" : (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    if (line.length + token.length > 75) {
      output += `${line}=\r\n`;
      line = "";
    }
    line += token;
  }
  return `${output}${line}\r\n`;
}

const base64 = (bytes: Uint8Array) => bytes.toBase64().replace(/.{1,76}/g, "$&\r\n");
const word = (charset: string, bytes: Uint8Array) => (random() < 0.5 ? `=?${charset}?B?${bytes.toBase64()}?=` : `=?${charset}?Q?${[...bytes].map((byte) => (byte > 32 && byte < 127 && byte !== 61 && byte !== 63 && byte !== 95 ? String.fromCharCode(byte) : byte === 32 ? "_" : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`)).join("")}?=`);

function headers(index: number, subject: string, extra: string) {
  const name = random() < 0.4 ? word("UTF-8", encoder.encode(`${pick(["Jörg", "Ånström", "Łukasz", "Søren"])} ${pick(["Müller", "Østergaard", "Kowalski"])}`)) : `"${pick(["Alice", "Bob", "Shop", "News"])} Team"`;
  const received = Array.from({ length: between(2, 5) }, (_, hop) => `Received: from mx${hop}.example.net (mx${hop}.example.net [192.0.2.${hop}])\r\n\tby mail.example.com with ESMTPS id ${index}x${hop}\r\n\tfor <me@example.com>; Mon, ${between(1, 28)} Sep 2026 1${hop}:2${hop}:00 +0200\r\n`).join("");
  return (
    received +
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.net; s=s1;\r\n\th=from:to:subject:date:message-id; bh=${encoder.encode(String(index)).toBase64()}=;\r\n\tb=${"A".repeat(300).replace(/.{1,70}/g, "$&\r\n\t")}\r\n` +
    `From: ${name} <sender${index % 97}@example.net>\r\nTo: me@example.com\r\n${random() < 0.3 ? "Cc: Other <other@example.org>, third@example.org\r\n" : ""}` +
    `Subject: ${subject}\r\nDate: ${pick(["Mon", "Tue", "Wed"])}, ${between(1, 28)} ${pick(["Jan", "Sep", "Oct"])} 2026 ${between(10, 23)}:${between(10, 59)}:${between(10, 59)} ${pick(["+0200", "-0700", "GMT", "+0000 (UTC)"])}\r\n` +
    `Message-ID: <${index}.${between(1000, 9999)}@example.net>\r\n${index % 3 ? `In-Reply-To: <${index - 1}@example.net>\r\nReferences: <${index - 2}@example.net> <${index - 1}@example.net>\r\n` : ""}` +
    `${index % 2 ? `List-Unsubscribe: <mailto:leave@example.net>, <https://example.net/u/${index}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n` : ""}MIME-Version: 1.0\r\nX-Mailer: Bench ${index}\r\n${extra}`
  );
}

function html(words: string[], paragraphs: number) {
  const rows = Array.from({ length: paragraphs }, (_, row) => `<tr><td style="padding:12px;font-family:Arial,sans-serif;color:#333333"><h2>${sentence(words, 4)}</h2><p>${sentence(words, between(30, 90))}</p><a href="https://example.net/item/${row}?utm_source=newsletter&amp;utm_medium=email">${sentence(words, 3)}</a><img src="https://cdn.example.net/${row}.png" width="600" alt=""></td></tr>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>td{font-size:14px}</style></head><body><table width="100%" cellpadding="0" cellspacing="0">${rows.join("\n")}</table></body></html>`;
}

function message(index: number): string {
  const kind = random();
  const boundary = `----=_Part_${index}_${between(100000, 999999)}`;
  if (kind < 0.35) {
    const body = sentence(english, between(40, 400)).replace(/(.{60,70}) /g, "$1\n");
    return `${headers(index, sentence(english, 6), "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n")}\r\n${body}\r\n`;
  }
  if (kind < 0.55) {
    const [charset, { encode, words }] = pick(Object.entries(charsets));
    const text = encode(sentence(words, between(60, 500)).replace(/(.{50,60}) /g, "$1\n"));
    const transfer = random() < 0.5 ? "quoted-printable" : "base64";
    const subject = word(charset, encode(sentence(words, 5)));
    return `${headers(index, subject, `Content-Type: text/plain; charset="${charset}"\r\nContent-Transfer-Encoding: ${transfer}\r\n`)}\r\n${transfer === "base64" ? base64(text) : qp(text)}`;
  }
  const words = random() < 0.8 ? english : pick(Object.values(charsets)).words;
  const plain = qp(encoder.encode(sentence(words, between(100, 600)).replace(/(.{60,70}) /g, "$1\n")));
  const markup = qp(encoder.encode(html(words, between(4, 40))));
  const alternative = `--${boundary}a\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${plain}--${boundary}a\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${markup}--${boundary}a--\r\n`;
  if (kind < 0.8) return `${headers(index, word("UTF-8", encoder.encode(`${sentence(words, 5)} ✓`)), `Content-Type: multipart/alternative; boundary="${boundary}a"\r\n`)}\r\nThis is a multi-part message in MIME format.\r\n\r\n${alternative}`;
  const files = Array.from({ length: between(1, 3) }, (_, file) => {
    const bytes = new Uint8Array(between(5_000, 200_000)).map(() => between(0, 256));
    const filename = file % 2 ? `filename*=UTF-8''${encodeURIComponent(`отчёт ${index}.pdf`)}` : `filename="report-${index}-${file}.pdf"`;
    return `--${boundary}m\r\nContent-Type: application/pdf; name="report-${index}.pdf"\r\nContent-Disposition: attachment;\r\n ${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(bytes)}`;
  });
  const inline = `--${boundary}m\r\nContent-Type: image/png\r\nContent-ID: <logo${index}@example.net>\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(new Uint8Array(between(2_000, 20_000)).map(() => between(0, 256)))}`;
  return `${headers(index, sentence(words, 7), `Content-Type: multipart/mixed; boundary="${boundary}m"\r\n`)}\r\n--${boundary}m\r\nContent-Type: multipart/alternative; boundary="${boundary}a"\r\n\r\n${alternative}${inline}${files.join("")}--${boundary}m--\r\n`;
}

export const corpus = Array.from({ length: 5000 }, (_, index) => encoder.encode(message(index)));

function walk(part: Part, sink: { text: number; attachments: number }) {
  if (attachmentName(part) !== null) sink.attachments += part.bodyRaw().length;
  else if (part.subparts.length) for (const child of part.subparts) walk(child, sink);
  else if (part.ctype.mimetype.startsWith("text/")) sink.text += part.body().length;
}

if (import.meta.main) {
  const dump = Bun.argv.indexOf("--dump");
  if (dump >= 0) {
    const output = Bun.argv[dump + 1] ?? "corpus.bin";
    await Bun.write(output, new Blob(corpus.flatMap((bytes) => [new Uint32Array([bytes.length]), bytes])));
    console.log(`wrote ${corpus.length} messages to ${output}`);
  }
  const megabytes = corpus.reduce((total, bytes) => total + bytes.length, 0) / 1024 / 1024;
  const run = (label: string, parse: (bytes: Uint8Array, index: number) => unknown) => {
    for (let round = 0; round < 2; round++) corpus.slice(0, 500).forEach(parse);
    const start = performance.now();
    corpus.forEach(parse);
    const seconds = (performance.now() - start) / 1000;
    console.log(`${label}: ${(corpus.length / seconds).toFixed(0)} messages/s, ${(megabytes / seconds).toFixed(1)} MB/s (${corpus.length} messages, ${megabytes.toFixed(1)} MB)`);
  };
  const header = (part: Part) => ["Date", "References", "In-Reply-To", "Message-ID", "Subject", "From", "Reply-To", "To", "Cc", "List-Unsubscribe", "List-Unsubscribe-Post"].map((name) => part.header(name) ?? "");
  run("mime headers", (bytes) => {
    const values = header(parseMail(bytes));
    try {
      dateparse(values[0] ?? "");
    } catch {}
  });
  run("mime full", (bytes) => {
    const part = parseMail(bytes);
    header(part);
    walk(part, { text: 0, attachments: 0 });
  });
  const { parse } = await import("../src/backend/parser");
  run("parser.parse headers", (bytes, index) => parse(index, bytes, false, false));
  run("parser.parse body", (bytes, index) => parse(index, bytes, false, true));
}
