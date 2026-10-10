import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";
import { type Draft, message } from "../models";
import { fromMessage } from "../models/draft";
import type { Action } from "../models/response";
import { Compose } from "./compose";
import { run } from "./html-editor";
import { useDisplay } from "./testing";

useDisplay();

test("autosaves HTML formatting without resaving loaded content", async () => {
  const compose = new Compose(new Gtk.Button());
  const submissions: Draft[] = [];
  compose.connectAutosave(() => (result) => {
    if (!result.ok) throw new Error(result.error);
    submissions.push(result.value);
    compose.autosave.complete({ ok: true, value: null });
  });
  compose.loadDraft(fromMessage(message({ recipients: "other@example.com", subject: "Formatted", bodyText: "Body", bodyHtml: "<p>Body</p>" })));
  const window = new Gtk.Window();
  window.set_child(compose.widget);
  window.present();
  const editor = compose["htmlEditor"];
  await editor.message();
  await Bun.sleep(2200);
  expect(submissions).toEqual([]);
  run(editor.view, "document.body.innerHTML = '<p><b>Body</b></p>'; report(true)");
  await Bun.sleep(2300);
  expect(submissions.length).toBe(1);
  expect(submissions[0]?.html).toBe("<p><b>Body</b></p>");
  expect(submissions[0]?.text.trim()).toBe("Body");
  expect(compose.widget.is_sensitive()).toBe(true);
  editor.view.stop_loading();
  window.destroy();
}, 20_000);

test("responses submit correct recipients, thread headers and forward source", async () => {
  const original = message({
    uid: 42,
    uidValidity: 7,
    messageId: "original@example.com",
    sender: "sender@example.com",
    replyTo: "support@example.com",
    recipients: "me@example.com, team@example.com",
    cc: "copy@example.com, TEAM@example.com",
    subject: "Plans",
    date: "Thu, 1 Oct 2026 10:00:00 +0000",
    references: ["parent@example.com"],
    bodyText: "Original body",
    attachments: ["report.pdf"],
    bodyLoaded: true,
  });
  const actions: Action[] = ["Reply", "ReplyAll", "Forward"];
  for (const action of actions) {
    const compose = new Compose(new Gtk.Button());
    compose.respond(original, "me@example.com", "INBOX", action);
    const [receiver, cc, subject] = [compose["receiver"], compose["cc"], compose["subject"]];
    if (action === "Forward") {
      expect([receiver.get_text(), cc.get_text(), subject.get_text()]).toEqual(["", "", "Fwd: Plans"]);
      expect(compose["attachments"].names()).toEqual(["report.pdf"]);
      receiver.set_text("forward@example.com");
    } else {
      expect(receiver.get_text()).toContain("support@example.com");
      expect(receiver.get_text()).not.toContain("sender@example.com");
      expect(subject.get_text()).toBe("Re: Plans");
      expect(compose["attachments"].names()).toEqual([]);
      if (action === "ReplyAll") expect([receiver.get_text(), cc.get_text()]).toEqual(["support@example.com, team@example.com", "copy@example.com"]);
      else expect(cc.get_text()).toBe("");
    }
    const submitted = Promise.withResolvers<Result<Draft>>();
    compose.connectSend(() => submitted.resolve);
    compose["send"].emit("clicked");
    const result = await submitted.promise;
    if (!result.ok) throw new Error(result.error);
    const draft = result.value;
    expect(draft.text).toContain("Original body");
    if (action === "Forward") {
      expect(draft.inReplyTo).toBeNull();
      expect(draft.references).toEqual([]);
      expect(draft.text).toContain("From: sender@example.com");
      expect(draft.attachmentSource).toEqual({ folder: "INBOX", uid: 42, validity: 7, messageId: "original@example.com" });
    } else {
      expect(draft.inReplyTo).toBe("original@example.com");
      expect(draft.references).toEqual(["parent@example.com", "original@example.com"]);
      expect(draft.attachmentSource).toBeNull();
    }
  }
});
