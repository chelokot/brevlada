import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Compose } from "../components/compose";
import { descendants } from "../components/testing";
import { message, type SentMessage } from "../models";
import type { Outcome } from "../models/draft";
import { showThread } from "./actions";
import { renderConversation } from "./conversation";
import { draftKey } from "./drafts";
import { event } from "./events";
import type { State } from "./state";
import { account, command, inbox, next, present, useWindows } from "./testing";

useWindows();

const subject = (compose: Compose) => compose["subject"];
const send = (compose: Compose) => compose["send"].emit("clicked");
const close = (compose: Compose) => compose["cancel"].emit("clicked");
const body = (compose: Compose) => compose["body"].get_buffer();
const newest = (state: State) => present(state.openComposers.at(-1)).compose;
const card = (state: State, uid: number) => present(state.cards.get(uid));
const editor = (state: State, id: string) => present(state.draftEditors.get(draftKey(state, "Drafts", id)));
const response = (widget: Gtk.Widget, icon: string) => present(descendants(widget).find((child): child is Gtk.Button => child instanceof Gtk.Button && child.get_icon_name() === icon));
const dialog = () => present(Gtk.Window.list_toplevels().find((window): window is Adw.MessageDialog => window instanceof Adw.MessageDialog && window.get_visible()));
const sent = (id: string) => ({ ok: true, value: { message: message({ messageId: id, bodyLoaded: true, isRead: true }), cleanupError: null } }) satisfies { ok: true; value: Outcome };
const related = (state: State, messages: SentMessage[]) =>
  event(state, { type: "RelatedSent", generation: state.generation, selection: state.selection, messages: structuredClone(messages) });
const draft = (id: string, uid: number): SentMessage => ({
  folder: "Drafts",
  message: message({
    uid,
    uidValidity: 7,
    messageId: id,
    subject: "Re: Topic",
    recipients: "other@example.com",
    cc: "copy@example.com",
    inReplyTo: "incoming",
    references: ["incoming"],
    isDraft: true,
    isRead: true,
    bodyLoaded: true,
    bodyText: `Body ${id}`,
  }),
});

test("new messages and replies keep independent drafts and original accounts", async () => {
  const { state, commands } = inbox("MultipleDraft", "me@example.com");
  const incoming = message({ uid: 1, messageId: "incoming", subject: "Topic", sender: "other@example.com", bodyText: "Original message", bodyLoaded: true, isRead: true });
  state.messages = [incoming];
  showThread(state, [incoming]);
  commands.length = 0;
  state.composeButton.emit("clicked");
  const first = newest(state);
  subject(first).set_text("First draft");
  body(first).set_text("Keep this body", -1);
  state.composeButton.emit("clicked");
  const second = newest(state);
  expect(subject(second).get_text()).toBe("");
  expect(second).not.toBe(first);
  const reply = response(card(state, 1).widget, "mail-reply-sender-symbolic");
  reply.emit("clicked");
  const firstReply = newest(state);
  subject(firstReply).set_text("Edited reply");
  reply.emit("clicked");
  const secondReply = newest(state);
  expect([subject(secondReply), subject(firstReply), subject(first)].map((entry) => entry.get_text())).toEqual(["Re: Topic", "Edited reply", "First draft"]);
  expect(state.openComposers.length).toBe(4);

  state.account = account("another@example.com");
  state.generation++;
  state.selection++;
  state.openGroup = [];
  state.relatedSent = [];
  renderConversation(state);
  for (const compose of [first, second, firstReply, secondReply]) expect(compose.widget.get_parent()).toBe(state.composers);
  send(first);
  send(firstReply);
  const firstRequest = await command(commands, "Compose");
  expect(firstRequest).toMatchObject({ account: { email: "me@example.com" }, target: null, draft: { subject: "First draft", text: "Keep this body", references: [], inReplyTo: null } });
  const replyRequest = await command(commands, "Compose");
  expect(replyRequest).toMatchObject({ account: { email: "me@example.com" }, target: null, draft: { subject: "Edited reply", inReplyTo: "incoming", references: ["incoming"] } });
  state.composeButton.emit("clicked");
  const latest = newest(state);
  expect(state.openComposers.length).toBe(5);
  event(state, { type: "Composed", request: replyRequest.request, result: { ok: false, error: "Offline" } });
  expect([firstReply.widget.is_sensitive(), first.widget.is_sensitive(), subject(firstReply).get_text()]).toEqual([true, false, "Edited reply"]);
  event(state, { type: "Composed", request: firstRequest.request, result: sent("sent-first") });
  expect(first.widget.get_parent()).toBeNull();
  expect(state.openComposers.length).toBe(4);
  expect(state.relatedSent).toEqual([]);
  close(second);
  expect(second.widget.get_parent()).toBeNull();
  expect(state.openComposers.length).toBe(3);
  for (const compose of [firstReply, secondReply, latest]) expect([compose.widget.get_visible(), compose.widget.get_parent() !== null]).toEqual([true, true]);
  subject(latest).set_text("New message");
  body(latest).set_text("Hello", -1);
  send(latest);
  expect(await command(commands, "Compose")).toMatchObject({ account: { email: "another@example.com" }, draft: { references: [] } });

  const loading = message({ uid: 2, messageId: "loading", subject: "Loading", sender: "other@example.com", isRead: true });
  state.messages.push(loading);
  showThread(state, [loading]);
  const pending = card(state, 2);
  const replyLoading = response(pending.widget, "mail-reply-sender-symbolic");
  replyLoading.emit("clicked");
  replyLoading.emit("clicked");
  response(pending.widget, "mail-forward-symbolic").emit("clicked");
  expect(pending.isResponsePending()).toBe(true);
  pending.error("Offline");
  expect(pending.isResponsePending()).toBe(true);
  const count = state.openComposers.length;
  pending.update({ ...loading, bodyLoaded: true, bodyText: "Loaded body" });
  expect(pending.isResponsePending()).toBe(false);
  expect(state.openComposers.slice(count).map(({ compose }) => subject(compose).get_text())).toEqual(["Re: Loading", "Re: Loading", "Fwd: Loading"]);
}, 30_000);

test("drafts update immediately, keep independent edits and confirm targeted deletion", async () => {
  const { state, commands } = inbox("EditableDraft", "me@example.com");
  const incoming = message({ uid: 1, messageId: "incoming", subject: "Topic", sender: "other@example.com", isRead: true, bodyLoaded: true });
  state.messages = [incoming];
  showThread(state, [incoming]);
  const incomingCard = card(state, 1).widget;
  commands.length = 0;
  const first = draft("first", 10);
  related(state, [first]);
  const firstEditor = editor(state, "first");
  expect(firstEditor.widget.get_parent()).toBe(state.viewer);
  expect(card(state, 1).widget).toBe(incomingCard);
  expect(next(commands)).toBeNull();
  expect(subject(firstEditor.compose).get_text()).toBe("Re: Topic");

  const second = draft("second", 11);
  second.message.bodyHtml = "<p><b>Formatted draft</b></p>";
  related(state, [first, { ...second, message: { ...second.message, bodyLoaded: false, bodyText: "", bodyHtml: "" } }]);
  expect(card(state, 1).widget).toBe(incomingCard);
  expect(await command(commands, "SentBody")).toMatchObject({ uid: 11 });
  expect(next(commands)).toBeNull();
  const loadingBox = editor(state, "second").widget;
  event(state, { type: "SentBody", generation: state.generation, selection: state.selection, folder: "Drafts", uid: 11, result: { ok: true, value: structuredClone(second.message) } });
  expect(editor(state, "second").widget).toBe(loadingBox);
  expect(card(state, 1).widget).toBe(incomingCard);
  expect(next(commands)).toBeNull();
  const secondEditor = editor(state, "second");
  expect(secondEditor.widget.get_parent()).toBe(state.viewer);
  expect(secondEditor.compose["cc"].get_text()).toBe("copy@example.com");
  subject(firstEditor.compose).set_text("First edited");
  subject(secondEditor.compose).set_text("Second edited");
  related(state, [first, second]);
  expect([subject(firstEditor.compose).get_text(), subject(secondEditor.compose).get_text()]).toEqual(["First edited", "Second edited"]);
  send(firstEditor.compose);
  send(secondEditor.compose);
  const firstSubmit = await command(commands, "Compose");
  const secondSubmit = await command(commands, "Compose");
  expect(firstSubmit).toMatchObject({ target: { uid: 10 }, draft: { subject: "First edited" } });
  expect(secondSubmit).toMatchObject({ target: { uid: 11 }, draft: { subject: "Second edited", html: "<p><b>Formatted draft</b></p>" } });
  expect(secondSubmit.draft.text.trim()).toBe("Formatted draft");
  event(state, { type: "Composed", request: secondSubmit.request, result: { ok: false, error: "Offline" } });
  expect([secondEditor.compose.widget.is_sensitive(), firstEditor.compose.widget.is_sensitive()]).toEqual([true, false]);
  event(state, { type: "Composed", request: firstSubmit.request, result: { ok: false, error: "Offline" } });
  expect(firstEditor.compose.widget.is_sensitive()).toBe(true);
  expect(subject(firstEditor.compose).get_text()).toBe("First edited");

  close(secondEditor.compose);
  expect(dialog().get_heading()).toBe("Are you sure you want to delete this draft?");
  dialog().response("cancel");
  expect(next(commands)).toBeNull();
  expect(secondEditor.widget.get_parent()).not.toBeNull();
  close(secondEditor.compose);
  dialog().response("delete");
  const deletion = await command(commands, "DeleteDraft");
  expect(deletion.target.uid).toBe(11);
  expect(card(state, 1).widget).toBe(incomingCard);
  expect(secondEditor.widget.get_parent()).toBeNull();
  related(state, [first, second]);
  expect(secondEditor.widget.get_parent()).toBeNull();
  expect(firstEditor.widget.get_parent()).not.toBeNull();
  event(state, { type: "DraftDeleted", request: deletion.request, result: { ok: false, error: "Offline" } });
  expect(secondEditor.widget.get_parent()).not.toBeNull();
  expect(subject(secondEditor.compose).get_text()).toBe("Second edited");
  close(secondEditor.compose);
  dialog().response("delete");
  const retry = await command(commands, "DeleteDraft");
  event(state, { type: "DraftDeleted", request: retry.request, result: { ok: true, value: null } });
  expect(secondEditor.widget.get_parent()).toBeNull();

  send(firstEditor.compose);
  const submit = await command(commands, "Compose");
  expect(submit.target).toMatchObject({ messageId: "first" });
  event(state, { type: "Composed", request: submit.request, result: sent("sent") });
  expect(firstEditor.widget.get_parent()).toBeNull();
  expect(state.sentCards.has("sent")).toBe(true);
  const late = draft("late", 20);
  late.message.bodyHtml = "<p>Late formatted draft</p>";
  state.relatedSent.push(late);
  renderConversation(state);
  const lateEditor = editor(state, "late");
  send(lateEditor.compose);
  state.account = account("another@example.com");
  state.generation++;
  state.relatedSent = [];
  state.openGroup = [];
  renderConversation(state);
  const lateSubmit = await command(commands, "Compose");
  expect(lateSubmit.account.email).toBe("me@example.com");
  event(state, { type: "Composed", request: lateSubmit.request, result: sent("late-sent") });
  expect(state.relatedSent).toEqual([]);
  expect(lateEditor.widget.get_parent()).toBeNull();
}, 30_000);
