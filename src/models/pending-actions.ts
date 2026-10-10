import type { Message } from ".";
import { type ActionTarget, matches } from "./action-target";
import { key } from "./senders";
import { flaggedState, readState, type SenderAction } from "./sender-action";

interface Scoped {
  account: string;
  folder: string;
}

interface Retained extends Scoped {
  message: Message;
  undoPending: boolean;
}

interface Restored extends Scoped {
  message: Message;
}

const toTarget = (target: ActionTarget | string): ActionTarget => (typeof target === "string" ? { kind: "Sender", sender: target } : target);
const targetKey = (account: string, folder: string, target: ActionTarget) =>
  JSON.stringify([account, folder, target.kind === "Sender" ? target.sender : target.messages]);
const messageKey = (account: string, folder: string, { uid, messageId }: Message) => JSON.stringify([account, folder, uid, messageId]);
const same = (left: Message, right: Message) => left.uid === right.uid && left.messageId === right.messageId;
const compatible = (left: Message, right: Message) => left.uidValidity === null || right.uidValidity === null || left.uidValidity === right.uidValidity;

export class PendingActions {
  readonly #pending = new Map<string, Scoped & { target: ActionTarget; action: SenderAction }>();
  readonly #removed = new Map<string, Set<number | null>>();
  readonly #spam = new Map<string, Retained>();
  readonly #restored = new Map<string, Restored>();

  begin(account: string, folder: string, target: ActionTarget | string, action: SenderAction) {
    const resolved = toTarget(target);
    const id = targetKey(account, folder, resolved);
    if (this.#pending.has(id)) return false;
    this.#pending.set(id, { account, folder, target: resolved, action });
    return true;
  }

  finish(account: string, folder: string, target: ActionTarget | string) {
    const id = targetKey(account, folder, toTarget(target));
    const entry = this.#pending.get(id);
    this.#pending.delete(id);
    return entry ? entry.action : null;
  }

  retainSpam(account: string, folder: string, messages: Message[]) {
    for (const message of messages) {
      this.#restored.delete(messageKey(account, folder, message));
      this.#spam.set(messageKey(account, folder, message), { account, folder, message, undoPending: false });
    }
  }

  finishSpam(account: string, folder: string, target: ActionTarget, moved: Message[]) {
    for (const [id, retained] of this.#spam)
      if (retained.account === account && retained.folder === folder && matches(target, retained.message) && !moved.some((message) => same(message, retained.message)))
        this.#spam.delete(id);
  }

  undoSpam(account: string, folder: string, target: ActionTarget) {
    const undone: Message[] = [];
    for (const retained of this.#spam.values())
      if (retained.account === account && retained.folder === folder && !retained.undoPending && matches(target, retained.message)) {
        retained.undoPending = true;
        undone.push(retained.message);
      }
    return undone;
  }

  finishUndoSpam(account: string, folder: string, originals: Message[], restored: Message[]) {
    for (const [id, retained] of this.#spam) {
      if (retained.account !== account || retained.folder !== folder || !originals.some((message) => same(message, retained.message))) continue;
      retained.undoPending = false;
      if (restored.some((message) => same(message, retained.message))) this.#spam.delete(id);
    }
  }

  holdRestored(account: string, folder: string, message: Message) {
    this.#restored.set(messageKey(account, folder, message), { account, folder, message });
  }

  dismissSpam(account: string, folder: string, sender: string) {
    let changed = false;
    for (const [id, retained] of this.#spam)
      if (retained.account === account && retained.folder === folder && key(retained.message) === sender) {
        this.#spam.delete(id);
        changed = true;
      }
    for (const [id, restored] of this.#restored)
      if (restored.account === account && restored.folder === folder && key(restored.message) === sender) this.#restored.delete(id);
    return changed;
  }

  isRetainedSpam(account: string, folder: string, message: Message) {
    const retained = this.#spam.get(messageKey(account, folder, message));
    return retained !== undefined && compatible(retained.message, message);
  }

  visible(account: string, folder: string, messages: Message[]) {
    const visible = messages.map((message) => this.project(account, folder, message)).filter((message) => message !== null);
    for (const retained of this.#spam.values()) {
      if (retained.account !== account || retained.folder !== folder || messages.some((message) => same(message, retained.message))) continue;
      const projected = this.project(account, folder, retained.message);
      if (projected) visible.push(projected);
    }
    for (const restored of this.#restored.values()) {
      if (restored.account !== account || restored.folder !== folder || visible.some((message) => same(message, restored.message))) continue;
      const projected = this.project(account, folder, restored.message);
      if (projected) visible.push(projected);
    }
    return visible;
  }

  confirmRemoved(account: string, folder: string, messages: Message[]) {
    for (const message of messages) {
      const id = messageKey(account, folder, message);
      this.#removed.set(id, (this.#removed.get(id) ?? new Set()).add(message.uidValidity));
    }
  }

  project(account: string, folder: string, message: Message): Message | null {
    const id = messageKey(account, folder, message);
    const stored = this.#spam.get(id);
    const retained = stored && compatible(stored.message, message) ? stored : null;
    const validities = this.#removed.get(id);
    if (!retained && validities && (message.uidValidity === null || validities.has(message.uidValidity))) return null;
    const visible = { ...message };
    if (retained) visible.isSpam = !retained.undoPending;
    for (const pending of this.#pending.values()) {
      if (pending.account !== account || pending.folder !== folder || !matches(pending.target, message)) continue;
      if (pending.action.kind === "Spam" && retained) continue;
      const read = readState(pending.action);
      const flagged = flaggedState(pending.action);
      if (read !== null) visible.isRead = read;
      else if (flagged !== null) visible.isFlagged = flagged;
      else return null;
    }
    return visible;
  }
}
