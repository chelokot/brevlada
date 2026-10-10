import { expect, test } from "bun:test";
import { message, type Account } from "../models";
import { parseIcal } from "../models/calendar";
import { draftReply } from "./calendar";
import { parseMail } from "./mime";

test("reply draft addresses the organizer and carries the matching mime method", () => {
  const [event] = parseIcal(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:20261002T120000Z\r\nORGANIZER:mailto:host@example.com\r\nATTENDEE:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  if (!event) throw new Error("missing event");
  const account: Account = { path: "", email: "me@example.com", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };
  const original = message({ subject: "Meeting", messageId: "invite@example.com" });
  const draft = draftReply(account, original, event, "Accepted");
  expect([draft.to, draft.inReplyTo, draft.references, draft.subject]).toEqual(["host@example.com", "invite@example.com", ["invite@example.com"], "Re: Meeting"]);
  expect(draft.text).toBe(`Accepted: ${event.name}\n\nme@example.com responded accepted to this invitation.`);
  const [attachment = ""] = draft.attachments;
  const part = parseMail(new TextEncoder().encode(attachment));
  expect(part.ctype.params.get("method")).toBe("REPLY");
  expect(parseIcal(part.body())[0]?.attendees[0]?.status).toBe("ACCEPTED");
});
