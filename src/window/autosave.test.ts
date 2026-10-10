import { expect, test } from "bun:test";
import { message } from "../models";
import { fromMessage, type Saved } from "../models/draft";
import { key, newComposer } from "./drafts";
import { event } from "./events";
import { command, inbox, next, present, useWindows } from "./testing";

useWindows();

const saved = (id: string, uid: number, subject: string): Saved => ({
  item: {
    folder: "Drafts",
    message: message({ uid, uidValidity: 7, messageId: id, subject, recipients: "other@example.com", bodyText: "Body", isDraft: true, isRead: true, bodyLoaded: true }),
  },
  originalParts: [],
  cleanupError: null,
});

test("autosave keeps typing and sends the latest text using the saved target", async () => {
  const { state, commands } = inbox("Autosave", "me@example.com");
  const compose = present(newComposer(state, "other@example.com", null));
  compose.loadDraft(fromMessage(message({ recipients: "other@example.com", bodyText: "Body" })));
  const subject = compose["subject"];
  subject.set_text("First");
  subject.set_text("Second");
  expect(next(commands)).toBeNull();
  const save = await command(commands, "SaveDraft");
  expect(save).toMatchObject({ target: null, account: { email: "me@example.com" }, draft: { subject: "Second" } });
  expect(compose.widget.is_sensitive()).toBe(true);
  subject.set_text("Latest");
  const send = compose["send"];
  expect(send.get_tooltip_text()).toBe("Send");
  send.emit("clicked");
  send.emit("clicked");
  expect(next(commands)).toBeNull();
  event(state, { type: "DraftSaved", request: save.request, result: { ok: true, value: saved("saved", 40, "Second") } });
  const submit = await command(commands, "Compose");
  expect(submit).toMatchObject({ draft: { subject: "Latest", attachmentsLoaded: true }, target: { messageId: "saved", uid: 40 } });
  expect(next(commands)).toBeNull();
  event(state, { type: "Composed", request: submit.request, result: { ok: true, value: { message: message({ messageId: "sent", bodyLoaded: true }), cleanupError: null } } });
  expect(compose.widget.get_visible()).toBe(false);
  expect(state.openComposers).toEqual([]);
  expect(state.draftRemoved.has(key("me@example.com", "Drafts", "saved"))).toBe(true);
}, 20_000);

test("closing flushes edits and failed saves keep the composer open", async () => {
  const { state, commands } = inbox("AutosaveClose", "me@example.com");
  const compose = present(newComposer(state, "other@example.com", null));
  const [subject, close] = [compose["subject"], compose["cancel"]];
  subject.set_text("Unfinished");
  close.emit("clicked");
  const flush = await command(commands, "SaveDraft");
  expect([flush.draft.subject, flush.draft.text]).toEqual(["Unfinished", ""]);
  event(state, { type: "DraftSaved", request: flush.request, result: { ok: false, error: "Offline" } });
  expect(compose.widget.get_visible()).toBe(true);
  expect(compose.autosave.status.get_text()).toContain("Offline");
  expect(subject.get_text()).toBe("Unfinished");
  close.emit("clicked");
  const retry = await command(commands, "SaveDraft");
  subject.set_text("Final close");
  event(state, { type: "DraftSaved", request: retry.request, result: { ok: true, value: saved("closed", 41, "Unfinished") } });
  expect(compose.widget.get_visible()).toBe(true);
  const latest = await command(commands, "SaveDraft");
  expect(latest).toMatchObject({ target: { uid: 41 }, draft: { subject: "Final close" } });
  event(state, { type: "DraftSaved", request: latest.request, result: { ok: true, value: saved("closed-latest", 42, "Final close") } });
  expect(compose.widget.get_visible()).toBe(false);
  expect(state.openComposers).toEqual([]);
  expect(state.draftLocal.has(key("me@example.com", "Drafts", "closed-latest"))).toBe(true);
}, 20_000);
