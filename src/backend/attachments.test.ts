import { expect, test } from "bun:test";
import { decode, encode } from "./attachments";
import { attachmentName, parseMail } from "./mime";
import { parse } from "./parser";

const bytes = (text: string) => new TextEncoder().encode(text);

test("encodes unicode names and binary data without injecting headers", () => {
  const name = 'résumé "東京".bin';
  const parsed = parseMail(bytes(encode(name, "application/octet-stream", new Uint8Array([0, 255, 13, 10]))));
  expect(attachmentName(parsed)).toBe(name);
  expect(parsed.bodyRaw()).toEqual(new Uint8Array([0, 255, 13, 10]));
  expect(attachmentName(parseMail(bytes(encode("../../evil\r\nBcc: test.txt", "text/plain", bytes("hello")))))).toBe("evilBcc: test.txt");
  expect(() => encode("test", "text/plain\r\nBcc: bad", new Uint8Array())).toThrow("Invalid attachment content type");
  expect(() => encode("big", "text/plain", new Uint8Array(20 * 1024 * 1024 + 1))).toThrow("Attachments must be smaller than 20 MB");
});

test("downloads duplicate names by position and refuses changed messages", () => {
  const first = encode("report.bin", "application/octet-stream", new Uint8Array([0, 255]));
  const second = encode("report.bin", "application/octet-stream", new Uint8Array([13, 10]));
  const raw = bytes(`Message-ID: <test@example.com>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHello\r\n--x\r\n${first}--x\r\n${second}--x--\r\n`);
  const message = parse(42, raw, false, true);
  expect(decode(message, raw, 0)).toEqual(new Uint8Array([0, 255]));
  expect(decode(message, raw, 1)).toEqual(new Uint8Array([13, 10]));
  expect(() => decode(message, raw, 2)).toThrow("Attachment is no longer available");
  expect(() => decode({ ...message, attachments: ["changed.bin", "report.bin"] }, raw, 0)).toThrow("Attachment changed; reload the message");
  expect(() => decode({ ...message, messageId: "other@example.com" }, raw, 1)).toThrow("Message changed; reload it before saving attachments");
});
