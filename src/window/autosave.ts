import type { Result } from "../backend/protocol";
import type { Compose } from "../components/compose";
import type { Draft } from "../models";
import type { Saved, Target } from "../models/draft";
import { completion, type Editor, key, pendingVisible, removeDraft, type Submission, takePending, updateDraftWidgets } from "./drafts";
import type { State } from "./state";

export function connectAutosave(state: State, compose: Compose, editor: Editor | null) {
  compose.connectAutosave(completion(state, compose, editor, saveComposer));
}

function saveComposer(state: State, { request, account, target }: Submission, draft: Result<Draft>) {
  if (!draft.ok) return draftSaved(state, request, draft);
  const { to, cc, subject, text, html, attachments, attachmentSource } = draft.value;
  if (target === null && [to, cc, subject, text, html ?? ""].every((field) => field.trim() === "") && attachments.length === 0 && attachmentSource === null) {
    const pending = takePending(state, request);
    if (pending) {
      pending.compose.autosave.complete({ ok: true, value: null });
      pending.compose.autosave.reset();
    }
    return;
  }
  state.sender.send({ type: "SaveDraft", account, draft: draft.value, target, request });
}

export function forgetSavedDraft(state: State, account: string, { folder, messageId }: Target) {
  const id = key(account, folder, messageId);
  state.draftRemoved.add(id);
  state.draftLocal.delete(id);
  state.relatedSent = state.relatedSent.filter((item) => item.folder !== folder || item.message.messageId !== messageId);
}

export const draftInComposer = (state: State, folder: string, id: string) =>
  state.openComposers.some(({ compose }) => {
    const draft = compose.draftTarget();
    return draft !== null && draft.folder === folder && draft.messageId === id;
  });

export function draftSaved(state: State, request: number, result: Result<Saved>) {
  const pending = takePending(state, request);
  if (!pending) return;
  if (!result.ok) return pending.compose.autosave.complete(result);
  const previous = pending.compose.draftTarget();
  if (previous) removeDraft(state, pending.account, previous);
  pending.compose.draftSaved(result.value);
  const { item, cleanupError } = result.value;
  const id = key(pending.account, item.folder, item.message.messageId);
  if (pending.editor) {
    pending.editor.source = item;
    state.draftEditors.set(id, pending.editor);
  }
  state.draftLocal.set(id, { account: pending.account, item, generation: pending.generation, selection: pending.selection });
  if (pendingVisible(state, pending)) {
    state.relatedSent.push(item);
    updateDraftWidgets(state);
  }
  pending.compose.autosave.complete(cleanupError === null ? { ok: true, value: null } : { ok: false, error: `Saved, but could not remove the previous draft: ${cleanupError}` });
}
