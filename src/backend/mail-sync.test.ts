import { expect, test } from "bun:test";
import { message } from "../models";
import { applyFlags, excludedFolder, hasSpecialUse, isDraft } from "./mail-sync";

test("recognizes drafts and gives idless headers a stable identity", () => {
  expect(hasSpecialUse(["\\drafts"], "\\Drafts")).toBeTrue();
  expect(isDraft("Entwürfe", [], "Entwürfe")).toBeTrue();
  expect(isDraft("Work", ["\\Draft"], null)).toBeTrue();
  expect(isDraft("[Gmail]/Drafts", [], null)).toBeTrue();
  expect(isDraft("Drafts research", [], null)).toBeFalse();
  const header = message({ uid: 7, recipients: "other@example.com" });
  applyFlags(header, "Entwürfe", [], "Entwürfe");
  const body = message({ uid: 7, recipients: "other@example.com", bodyText: "Hello", bodyLoaded: true });
  applyFlags(body, "Entwürfe", ["\\Draft"], null);
  expect(header.isDraft).toBeTrue();
  expect(header.messageId).not.toBe("");
  expect(header.messageId).toBe(body.messageId);
});

test("marks junk and flags from server flags and folder names", () => {
  const spam = message({ uid: 1, messageId: "<id>" });
  applyFlags(spam, "INBOX", ["$junk", "\\Flagged"], null);
  expect([spam.isSpam, spam.isFlagged, spam.isDraft, spam.messageId]).toEqual([true, true, false, "<id>"]);
  const bulk = message({ uid: 2 });
  applyFlags(bulk, "Archive.Bulk Mail", [], null);
  expect([bulk.isSpam, bulk.isFlagged, bulk.messageId]).toEqual([true, false, ""]);
});

test("excludes server special use and common nested names", () => {
  expect(excludedFolder("Papierkorb", ["\\Trash"])).toBeTrue();
  expect(excludedFolder("Unwanted", ["\\Junk"])).toBeTrue();
  expect(excludedFolder("[Gmail]/Spam", [])).toBeTrue();
  expect(excludedFolder("INBOX.Trash.Old", [])).toBeTrue();
  expect(excludedFolder("Work/Spam research", [])).toBeFalse();
  expect(excludedFolder("INBOX", [])).toBeFalse();
});
