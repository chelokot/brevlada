import { expect, test } from "bun:test";
import type { Account } from "../models";
import { message } from "../models";
import { fromMessage, target } from "../models/draft";
import { encode } from "./attachments";
import { prepareSend, removeUid, resolve, forwardAttachments, retainSelected } from "./drafts";
import { parseMail } from "./mime";
import { scripted } from "./testing";

const bytes = (text: string) => new TextEncoder().encode(text);
const account: Account = { path: "", email: "me@example.com", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };

test("sends materialized attachments without fetching or duplicating them", async () => {
  const source = message({ uid: 1, messageId: "draft", attachments: ["file.bin"] });
  const draft = { ...fromMessage(source), attachmentsLoaded: true, attachments: [encode("file.bin", "application/octet-stream", new Uint8Array([0, 255]))] };
  const prepared = await prepareSend(account, draft, target("Drafts", source));
  expect(prepared.attachments).toEqual(draft.attachments);
});

test("forwarding retains attachments and checks source identity", async () => {
  const raw =
    "Message-ID: <source@example.com>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOriginal body\r\n" +
    "--x\r\nContent-Type: application/octet-stream; name=report.bin\r\nContent-Disposition: attachment; filename=report.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8K\r\n--x--\r\n";
  for (const [validity, id, removed, count] of [
    [7, "source@example.com", [], 1],
    [7, "source@example.com", [0], 0],
    [8, "source@example.com", [], null],
    [7, "other@example.com", [], null],
  ] as const) {
    const { session, sent } = await scripted(`* OK [UIDVALIDITY ${validity}] valid\r\na2 OK examine\r\n* 1 FETCH (UID 42 BODY[] {${raw.length}}\r\n${raw})\r\na3 OK fetch\r\n`);
    const result = forwardAttachments(session, { folder: "INBOX", uid: 42, validity: 7, messageId: id }, [...removed]);
    if (count === null) await expect(result).rejects.toThrow();
    else {
      const parts = await result;
      expect(parts).toHaveLength(count);
      for (const part of parts.map((part) => parseMail(bytes(part)))) {
        expect(part.bodyRaw()).toEqual(new Uint8Array([0, 255, 10]));
        expect(part.disposition().params.get("filename")).toBe("report.bin");
      }
    }
    const written = await sent();
    expect(written).toContain('EXAMINE "INBOX"');
    expect(written).not.toContain("STORE");
  }
});

test("deletes only the verified uid and refuses changed mailboxes or messages", async () => {
  const header = "Message-ID: <draft@example.com>\r\n\r\n";
  for (const [validity, id, success] of [
    [7, "draft@example.com", true],
    [8, "draft@example.com", false],
    [7, "different", false],
  ] as const) {
    const { session, sent } = await scripted(
      `* OK [UIDVALIDITY ${validity}] valid\r\na2 OK select\r\n* 1 FETCH (UID 42 FLAGS (\\Draft) BODY[HEADER] {${header.length}}\r\n${header})\r\na3 OK fetch\r\n` +
        "* CAPABILITY IMAP4rev1 UIDPLUS\r\na4 OK capabilities\r\n* OK [UIDVALIDITY 7] valid\r\na5 OK select\r\na6 OK store\r\na7 OK expunge\r\n",
    );
    const removal = (async () => {
      const location = await resolve(session, { folder: "Drafts", uid: 42, validity: 7, messageId: id });
      if (!location) throw new Error("missing");
      await removeUid(session, "Drafts", ...location);
    })();
    if (success) await removal;
    else await expect(removal).rejects.toThrow();
    const written = await sent();
    if (success) {
      expect(written).toContain("UID STORE 42 +FLAGS.SILENT (\\Deleted)");
      expect(written).toContain("UID EXPUNGE 42");
      expect(written).not.toContain("a7 EXPUNGE");
    } else {
      expect(written).not.toContain("STORE");
      expect(written).not.toContain("EXPUNGE");
    }
  }
});

test("retains attachment bytes and inline content ids when editing a draft", () => {
  const original = parseMail(
    bytes(
      "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOld body\r\n--x\r\nContent-Type: application/octet-stream; name=report.bin\r\nContent-Disposition: attachment; filename=report.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8K\r\n" +
        "--x\r\nContent-Type: image/png\r\nContent-ID: <inline>\r\n\r\nPNG\r\n--x--\r\n",
    ),
  );
  const [attachment, inline, ...rest] = retainSelected(original, []).map((part) => parseMail(bytes(part)));
  expect(rest).toEqual([]);
  expect(attachment && attachment.bodyRaw()).toEqual(new Uint8Array([0, 255, 10]));
  expect(attachment && attachment.disposition().params.get("filename")).toBe("report.bin");
  expect(inline && inline.header("Content-ID")).toBe("<inline>");
});
