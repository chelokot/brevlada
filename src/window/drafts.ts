import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";
import { column, horizontal, label } from "../components";
import { type Complete, Compose } from "../components/compose";
import type { Account, Draft, Message, SentMessage } from "../models";
import { related } from "../models/conversation";
import { fromMessage, type Outcome, type Target, target } from "../models/draft";
import type { Action } from "../models/response";
import { SMALL_SPACING } from "../theme";
import { open, openSent } from "./actions";
import { connectAutosave, draftInComposer, forgetSavedDraft } from "./autosave";
import { renderConversation } from "./conversation";
import type { State } from "./state";

export interface OpenComposer {
  compose: Compose;
  account: Account;
  generation: number;
  selection: number;
}

export interface Editor {
  widget: Gtk.Box;
  compose: Compose;
  account: Account;
  source: SentMessage;
  loaded: boolean;
  confirming: boolean;
  status: Gtk.Box;
  statusLabel: Gtk.Label;
  retry: Gtk.Button;
}

export interface Pending {
  compose: Compose;
  editor: Editor | null;
  account: string;
  generation: number;
  selection: number;
}

export interface Submission {
  request: number;
  account: Account;
  target: Target | null;
}

export interface Local {
  account: string;
  item: SentMessage;
  generation: number;
  selection: number;
}

export const key = (account: string, folder: string, messageId: string) => JSON.stringify([account, folder, messageId]);

export const draftKey = (state: State, folder: string, id: string) => key(state.account ? state.account.email : "", folder, id);

const editorKey = ({ account, source }: Editor) => key(account.email, source.folder, source.message.messageId);

const editorTarget = ({ source }: Editor) => target(source.folder, source.message);

export const nextComposerRequest = (state: State) => state.sender.nextRequest();

export function newComposer(state: State, receiver: string, response: [message: Message, folder: string, action: Action] | null) {
  const { account } = state;
  if (!account) {
    state.toast.add_toast(Adw.Toast.new("Select an account first"));
    return null;
  }
  const compose = new Compose(state.composeButton);
  state.openComposers.push({ compose, account, generation: state.generation, selection: state.selection });
  connectComposer(state, compose, null);
  compose.connectCancel(() => {
    closeComposer(state, compose);
    state.composeButton.grab_focus();
  });
  state.composers.prepend(compose.widget);
  if (response) compose.respond(response[0], account.email, response[1], response[2]);
  else compose.show(receiver);
  const adjustment = state.viewerScroll.get_vadjustment();
  adjustment.set_value(adjustment.get_lower());
  return compose;
}

function closeComposer(state: State, compose: Compose) {
  compose.finishSend(true);
  compose.autosave.reset();
  if (compose.widget.get_parent() === state.composers) state.composers.remove(compose.widget);
  state.openComposers = state.openComposers.filter((open) => open.compose !== compose);
  renderConversation(state);
}

export function draftEditor(state: State, folder: string, message: Message) {
  const id = draftKey(state, folder, message.messageId);
  const editor = state.draftEditors.get(id) ?? createEditor(state, id, folder, message);
  if (message.bodyLoaded && !editor.loaded) {
    editor.loaded = true;
    editor.compose.loadDraft(fromMessage(message));
    editor.compose.setDraftTarget(target(folder, message));
    editor.compose.setReady(true);
    editor.compose.widget.set_sensitive(true);
    editor.status.set_visible(false);
    editor.source = { folder, message };
  }
  return editor;
}

function createEditor(state: State, id: string, folder: string, message: Message) {
  if (!state.account) throw new Error("Draft needs an account");
  const compose = new Compose(state.composeButton);
  compose.discardOnClose();
  if (!message.bodyLoaded) compose.loadDraft(fromMessage(message));
  compose.setReady(false);
  const widget = column("draft-editor");
  widget.append(compose.widget);
  const status = horizontal("draft-status", SMALL_SPACING);
  const statusLabel = label("Loading draft…", "dim-label");
  const retry = Gtk.Button.new_with_label("Retry");
  retry.set_visible(false);
  status.append(statusLabel);
  status.append(retry);
  widget.append(status);
  const editor: Editor = { widget, compose, account: state.account, source: { folder, message }, loaded: false, confirming: false, status, statusLabel, retry };
  connectComposer(state, compose, editor);
  compose.connectCancel(() => {
    if (editor.confirming) return;
    editor.confirming = true;
    confirmDraftDelete(state, editor);
  });
  retry.connect("clicked", () => {
    const { folder, message } = editor.source;
    statusLabel.set_text("Loading draft…");
    retry.set_visible(false);
    state.sentPending.delete(message.messageId);
    openSent(state, folder, message.uid, message.messageId);
  });
  state.draftEditors.set(id, editor);
  return editor;
}

export function updateDraftWidgets(state: State) {
  const items = [
    ...state.openGroup.map((original) => ({
      sent: false,
      folder: state.folder,
      message: state.messages.find((message) => message.uid === original.uid && message.messageId === original.messageId) ?? original,
    })),
    ...state.relatedSent.map(({ folder, message }) => ({ sent: true, folder, message })),
  ]
    .filter(({ folder, message }) => !state.draftRemoved.has(draftKey(state, folder, message.messageId)))
    .sort((left, right) => right.message.timestamp - left.message.timestamp || right.message.uid - left.message.uid)
    .slice(0, state.conversationLimit);
  const desired: [draft: boolean, widget: Gtk.Widget][] = [];
  for (const { sent, folder, message } of items) {
    if (message.isDraft) {
      if (draftInComposer(state, folder, message.messageId)) continue;
      const editor = draftEditor(state, folder, message);
      desired.push([true, editor.widget]);
      if (!message.bodyLoaded && !editor.loaded) {
        if (sent) openSent(state, folder, message.uid, message.messageId);
        else open(state, message.uid);
      }
    } else {
      const card = sent ? state.sentCards.get(message.messageId) : state.cards.get(message.uid);
      if (!card) return renderConversation(state);
      desired.push([false, card.widget]);
    }
  }
  const wanted = new Set(desired.map(([, widget]) => widget));
  const first = state.viewer.get_first_child();
  let previous = first && !first.has_css_class("draft-editor") && !wanted.has(first) ? first : null;
  for (let child = first; child; ) {
    const widget = child;
    child = widget.get_next_sibling();
    if (widget.has_css_class("draft-editor") && !wanted.has(widget)) state.viewer.remove(widget);
  }
  for (const [draft, widget] of desired) {
    if (draft && widget.get_parent()) state.viewer.reorder_child_after(widget, previous);
    else if (draft) state.viewer.insert_child_after(widget, previous);
    previous = widget;
  }
}

export function draftBodyError(state: State, folder: string, id: string, error: string) {
  const editor = state.draftEditors.get(draftKey(state, folder, id));
  if (!editor) return;
  editor.statusLabel.set_text(error);
  editor.retry.set_visible(true);
}

function connectComposer(state: State, compose: Compose, editor: Editor | null) {
  connectAutosave(state, compose, editor);
  compose.connectSend(completion(state, compose, editor, submitComposer));
}

export function completion(state: State, compose: Compose, editor: Editor | null, finish: (state: State, submission: Submission, draft: Result<Draft>) => void) {
  return (): Complete => {
    const origin = state.openComposers.find((open) => open.compose === compose);
    const owner = editor ?? origin;
    if (!owner) {
      compose.sendFailed("Select an account first");
      return () => {};
    }
    const { account } = owner;
    const request = nextComposerRequest(state);
    const { generation, selection } = origin ?? state;
    state.composerPending.set(request, { compose, editor, account: account.email, generation, selection });
    const submission = { request, account, target: compose.draftTarget() ?? (editor ? editorTarget(editor) : null) };
    return (draft) => finish(state, submission, draft);
  };
}

function submitComposer(state: State, { request, account, target }: Submission, draft: Result<Draft>) {
  if (draft.ok) state.sender.send({ type: "Compose", account, draft: draft.value, target, request });
  else composerFinished(state, request, draft);
}

function confirmDraftDelete(state: State, editor: Editor) {
  const parent = state.toast.get_root();
  const dialog = Adw.MessageDialog.new(parent instanceof Gtk.Window ? parent : null, "Are you sure you want to delete this draft?", null);
  dialog.add_response("cancel", "Keep Draft");
  dialog.add_response("delete", "Delete");
  dialog.set_response_appearance("delete", Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.set_default_response("cancel");
  dialog.set_close_response("cancel");
  dialog.connect("response", (_dialog, response) => {
    editor.confirming = false;
    if (response === "delete") deleteDraft(state, editor);
    else editor.compose.autosave.resume();
  });
  dialog.present();
}

export function removeDraft(state: State, account: string, draft: Target) {
  forgetSavedDraft(state, account, draft);
  state.draftEditors.delete(key(account, draft.folder, draft.messageId));
}

function deleteDraft(state: State, editor: Editor) {
  if (!editor.compose.widget.is_sensitive()) return;
  editor.compose.widget.set_sensitive(false);
  const request = nextComposerRequest(state);
  const { account } = editor;
  const draft = editorTarget(editor);
  state.composerPending.set(request, { compose: editor.compose, editor, account: account.email, generation: state.generation, selection: state.selection });
  removeDraft(state, account.email, draft);
  updateDraftWidgets(state);
  state.sender.send({ type: "DeleteDraft", account, target: draft, request });
}

export const pendingVisible = (state: State, pending: Pending) =>
  pending.generation === state.generation && pending.selection === state.selection && state.account !== null && state.account.email === pending.account;

export function takePending(state: State, request: number) {
  const pending = state.composerPending.get(request);
  state.composerPending.delete(request);
  return pending;
}

export function composerFinished(state: State, request: number, result: Result<Outcome>) {
  const pending = takePending(state, request);
  if (!pending) return;
  if (!result.ok) return pending.compose.sendFailed(result.error);
  const visible = pendingVisible(state, pending);
  const previous = pending.compose.draftTarget();
  if (previous) forgetSavedDraft(state, pending.account, previous);
  const item: SentMessage = { folder: "", message: result.value.message };
  if (pending.editor) {
    removeDraft(state, pending.editor.account.email, editorTarget(pending.editor));
    pending.compose.finishSend(true);
  } else closeComposer(state, pending.compose);
  state.draftLocal.set(key(pending.account, item.folder, item.message.messageId), { account: pending.account, item, generation: pending.generation, selection: pending.selection });
  if (visible) {
    state.relatedSent = [...state.relatedSent.filter((old) => old.message.messageId !== item.message.messageId), item];
    renderConversation(state);
  }
  const { cleanupError } = result.value;
  state.toast.add_toast(Adw.Toast.new(cleanupError === null ? "Message sent" : `Message sent, but could not remove the previous draft: ${cleanupError}`));
}

export function draftDeleted(state: State, request: number, result: Result<null>) {
  const pending = takePending(state, request);
  if (!pending || result.ok) return;
  const { editor } = pending;
  if (editor) {
    const id = editorKey(editor);
    state.draftRemoved.delete(id);
    state.draftEditors.set(id, editor);
    editor.compose.finishSend(false);
    editor.compose.autosave.resume();
    if (pendingVisible(state, pending)) {
      state.relatedSent.push(editor.source);
      updateDraftWidgets(state);
    }
  }
  state.toast.add_toast(Adw.Toast.new(`Could not delete draft: ${result.error}`));
}

export function reconcileDrafts(state: State, messages: SentMessage[]) {
  if (!state.account) return;
  const account = state.account.email;
  const kept = messages.filter((item) => !state.draftRemoved.has(key(account, item.folder, item.message.messageId)));
  messages.splice(0, messages.length, ...kept);
  for (const [id, local] of state.draftLocal) {
    if (local.account !== account) continue;
    const { folder, message } = local.item;
    if (messages.some((item) => item.folder === folder && item.message.messageId === message.messageId && item.message.uid !== 0)) state.draftLocal.delete(id);
    else if ((local.generation === state.generation && local.selection === state.selection) || related(state.openGroup, [local.item]).length > 0) messages.push(local.item);
  }
}
