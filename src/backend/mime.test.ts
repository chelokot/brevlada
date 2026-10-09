import { expect, test } from "bun:test";
import { attachmentName, dateparse, parseMail } from "./mime";

const bytes = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);

test("decodes RFC 2047 words like mailparse, including its boundary and charset rules", () => {
  for (const [value, expected] of [
    ["=?UTF-8?Q?a?= =?UTF-8?Q?b?=", "ab"],
    ["=?UTF-8?Q?a?=\r\n =?UTF-8?Q?b?= c", "ab c"],
    ["Re: =?ISO-8859-1?Q?Gr=FC=DFe?= aus", "Re: Grüße aus"],
    ["=?windows-1251?B?z/Do4uXy?=", "Привет"],
    ["=?bogus?Q?x?= =?utf-7?Q?+AGEAYgBj-?=", "=?bogus?Q?x?= abc"],
    ["a=?UTF-8?Q?b?= =?UTF-8?B?aGk?= =?UTF-8?B?aGk=?=", "a=?UTF-8?Q?b?= =?UTF-8?B?aGk?= hi"],
    ["plain\r\n\tfolded", "plain folded"],
    ["\ufeffbom", "\ufeffbom"],
  ] as const) {
    expect(parseMail(utf8(`Subject: ${value}\r\n\r\n`)).header("subject")).toBe(expected);
  }
  expect(parseMail(bytes("Subject: caf\xe9\r\n\r\n")).header("Subject")).toBe("café");
});

test("parses RFC 2231 parameters, continuations and disposition types", () => {
  for (const [value, type, params] of [
    ["attachment; filename*0*=UTF-8''%E2%82%AC; filename*1*=%20rate.pdf", "attachment", [["filename", "€ rate.pdf"]]],
    ['attachment; filename*0="long "; filename*1="name.txt"', "attachment", [["filename", "long name.txt"]]],
    ['INLINE; FILENAME = "quoted.txt"; size=3', "inline", [["filename", "quoted.txt"], ["size", "3"]]],
    ["attachment; filename*=iso-8859-1'en'%E9t%E9.txt", "attachment", [["filename", "été.txt"]]],
    ["attachment; filename*=bogus''x.txt", "attachment", [["filename*", "bogus''x.txt"]]],
  ] as const) {
    const disposition = parseMail(utf8(`Content-Disposition: ${value}\r\n\r\n`)).disposition();
    expect([disposition.type, [...disposition.params]]).toEqual([type, params.map(([key, entry]) => [key, entry])]);
  }
});

test("decodes transfer encodings and charsets with mailparse's error texts", () => {
  for (const [encoding, charset, body, expected] of [
    ["quoted-printable", "utf-8", "soft=\r\nbreak =C3=A9 =c3=a9 =ZZ =4\r\ntrailing   \r\n", "softbreak é é =ZZ =4\r\ntrailing\r\n"],
    ["base64", "utf-8", "aGk=aGk=\r\n", "hihi"],
    ["base64", "utf-8", "aGVsbG8\r\n", "Base64 decode error: invalid length at 4"],
    ["base64", "utf-8", "aG!s\r\n", "Base64 decode error: invalid symbol at 2"],
    ["base64", "utf-8", "a===\r\n", "Base64 decode error: invalid padding length at 1"],
    ["8bit", "koi8-r", "\xf0\xd2\xc9\xd7\xc5\xd4", "Привет"],
    ["7bit", "iso-2022-jp", "\x1b$B$3$s$K$A$O\x1b(B", "こんにちは"],
    ["8bit", "x-unknown", "caf\xe9", "caf\ufffd"],
    ["binary", "utf-8", "\xff\xfeh\x00i\x00", "hi"],
  ] as const) {
    const part = parseMail(bytes(`Content-Type: text/plain; charset=${charset}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}`));
    let text: string;
    try {
      text = part.body();
    } catch (error) {
      text = error instanceof Error ? error.message : "";
    }
    expect(text).toBe(expected);
  }
});

test("splits multipart trees with preambles, nested parts, digests and missing terminators", () => {
  const mail = parseMail(
    utf8(
      'Content-Type: multipart/mixed; boundary="outer"\r\n\r\npreamble\r\n--outer\r\nContent-Type: multipart/digest; boundary=inner\r\n\r\n--inner\r\n\r\nSubject: digested\r\n\r\n--inner--\r\n' +
        "--outer \r\nContent-Type: text/plain\r\n\r\nnot --outer at line start\r\n--outer\r\nContent-Type: text/html\r\n\r\nunterminated",
    ),
  );
  expect(new TextDecoder().decode(mail.content)).toBe("preamble");
  expect(mail.subparts.map((part) => part.ctype.mimetype)).toEqual(["multipart/digest", "text/plain", "text/html"]);
  expect(mail.subparts[0]?.subparts.map((part) => part.ctype.mimetype)).toEqual(["message/rfc822"]);
  expect(mail.subparts.slice(1).map((part) => part.body())).toEqual(["not --outer at line start", "unterminated"]);
  expect(() => parseMail(utf8(" Overhang: x\r\n\r\n"))).toThrow("Header cannot start with a space; it is likely an overhanging line from a previous header");
  expect(() => parseMail(utf8("A: b\r\n\rbody"))).toThrow("Headers were followed by an unexpected lone CR character!");
  expect(parseMail(utf8("NoColon\r\nKey:  value \r\n\r\n")).headers.map(({ key }) => key)).toEqual(["NoColon\r", "Key"]);
});

test("names attachments like the Rust model", () => {
  for (const [headers, expected] of [
    ["Content-Disposition: attachment", "Unnamed attachment"],
    ["Content-Type: image/png; name=logo.png\r\nContent-ID: <logo>", null],
    ["Content-Disposition: attachment; filename=a.png\r\nContent-ID: <logo>", "a.png"],
    ["Content-Type: application/pdf; name=fallback.pdf", "fallback.pdf"],
    ["Content-Type: text/plain", null],
  ] as const) {
    expect(attachmentName(parseMail(utf8(`${headers}\r\n\r\nx`)))).toBe(expected);
  }
});

test("parses dates with mailparse's arithmetic and errors", () => {
  for (const [date, expected] of [
    ["Thu, 8 Oct 2026 13:00:00 +0200", 1791457200],
    ["8 oct 26 1:2:3 PDT", 1791446523],
    ["1 Jan 70 0:0:0 Z", 0],
    ["Fri, 31 Feb 2030 23:59:59 -2400", 1898899199],
    ["1 Jan 99999 0:0:0 +0000", 3093496444800],
    ["+5 Jan 2026 +1:+2:+3 +0100", 1767571323],
    ["Mon", 0],
    ["Sat, 3 Sept 2026", "Unrecognized month"],
    ["32 Oct 2026", "Invalid day"],
    ["1 Oct 1969", "Disallowed year"],
    ["5 Jan 100", "Disallowed year"],
    ["1 Oct 2026 10:00:00 +2500", "Invalid timezone"],
    ["5 Jan 2026 256:0:0", "Invalid hour"],
  ] as const) {
    if (typeof expected === "number") expect(dateparse(date)).toBe(expected);
    else expect(() => dateparse(date)).toThrow(expected);
  }
});
