import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import { selectMessage } from "../components/states";
import { groups } from "../components/virtual-list";
import { listHeader, type Message, searchDocument } from "../models";
import { type ActionTarget, matches } from "../models/action-target";
import { removesMessages, type SenderAction } from "../models/sender-action";
import { key } from "../models/senders";
import { sameAscii } from "../models/text";
import { newSelection } from "./actions";
import { advanceMessage } from "./message-navigation";
import { overlaps, renderList } from "./rendering";
import type { State } from "./state";

export function senderAction(state: State, target: ActionTarget, action: SenderAction) {
  if (action.kind === "MoveTo" && !action.folder) {
    moveDialog(state, target);
    return;
  }
  const { account, folder } = state;
  if (!account) return;
  if (action.kind === "Unspam") {
    const originals = state.senderActions.undoSpam(account.email, folder, target);
    if (originals.length > 0) {
      state.sender.send({ type: "UndoSpam", account, folder, originals });
      return refreshSenderView(state);
    }
    if (visibleMessages(state).some((message) => matches(target, message) && retainedSpam(state, message))) return;
  }
  const spam =
    action.kind === "Spam"
      ? [...state.messages, ...state.senderPane.messages(), ...state.openGroup]
          .filter((message) => matches(target, message))
          .map((message) => visibleMessage(state, message))
          .filter((message) => message !== null)
      : [];
  if (!state.senderActions.begin(account.email, folder, target, action)) return;
  if (action.kind === "Spam") state.senderActions.retainSpam(account.email, folder, spam);
  state.sender.send({ type: "SenderAction", account, folder, sender: target, action });
  const affectsOpenMessage = state.openGroup.some((message) => matches(target, message));
  const replaceOpenMessage = removesMessages(action) && action.kind !== "Spam" && affectsOpenMessage;
  if (replaceOpenMessage) {
    const senderIndex = groups(state.list).findIndex(([first]) => first !== undefined && state.senderPane.sender() === key(first));
    const threadIndex = groups(state.threadList).findIndex((group) => overlaps(group, state.openGroup));
    state.nextMessage = [Math.max(senderIndex, 0), Math.max(threadIndex, 0)];
  }
  if (replaceOpenMessage || (action.kind === "MarkUnread" && affectsOpenMessage)) {
    newSelection(state);
    state.deferredReadSort.clear();
    state.selected = [];
    state.cards.clear();
    state.sentCards.clear();
    state.relatedSent = [];
    state.openGroup = [];
    selectMessage(state.viewer);
  }
  refreshSenderView(state);
  if (replaceOpenMessage) advanceMessage(state);
}

export function menuActions(state: State, target: ActionTarget): SenderAction[] {
  const targeted = [...visibleMessages(state), ...state.senderPane.messages()]
    .map((message) => visibleMessage(state, message))
    .filter((message) => message !== null)
    .filter((message) => matches(target, message));
  if (targeted.length > 0 && targeted.every((message) => retainedSpam(state, message))) return [{ kind: "Unspam" }];
  return menuActionsForMessages(state.folder, targeted);
}

export function moveDialog(state: State, target: ActionTarget) {
  if (!state.account) return null;
  const account = state.account.email;
  const { folder } = state;
  const lower = (name: string) => name.toLowerCase();
  const folders = (state.folderNames.get(account) ?? [])
    .filter((destination) => !sameAscii(destination, folder))
    .sort((left, right) => (lower(left) < lower(right) ? -1 : lower(left) > lower(right) ? 1 : 0))
    .filter((destination, index, sorted) => destination !== sorted[index - 1]);
  if (folders.length === 0) {
    state.toast.add_toast(Adw.Toast.new("No destination folders available. Refresh the account and retry."));
    return null;
  }
  const parent = state.toast.get_root();
  const dialog = Adw.MessageDialog.new(parent instanceof Gtk.Window ? parent : null, "Move to…", "Choose a destination folder.");
  const destination = Gtk.DropDown.new_from_strings(folders);
  destination.set_enable_search(true);
  destination.update_property([Gtk.AccessibleProperty.LABEL], ["Destination folder"]);
  dialog.set_extra_child(destination);
  dialog.add_response("cancel", "Cancel");
  dialog.add_response("move", "Move");
  dialog.set_response_appearance("move", Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response("move");
  dialog.set_close_response("cancel");
  dialog.connect("response", (_dialog, response) => {
    if (response !== "move") return;
    if (!state.account || state.account.email !== account || state.folder !== folder)
      return state.toast.add_toast(Adw.Toast.new("The active mailbox changed. Choose the messages again."));
    const chosen = folders[destination.get_selected()];
    if (chosen !== undefined) senderAction(state, target, { kind: "MoveTo", folder: chosen });
  });
  dialog.present();
  return dialog;
}

export const visibleMessage = (state: State, message: Message) => (state.account ? state.senderActions.project(state.account.email, state.folder, message) : message);

export const visibleMessages = (state: State) => visibleGroup(state, state.messages);

export const visibleGroup = (state: State, messages: Message[]) => (state.account ? state.senderActions.visible(state.account.email, state.folder, messages) : [...messages]);

export const visibleListGroup = (state: State, messages: Message[], threads: boolean) =>
  visibleGroup(state, messages.map((message) => listHeader(message, threads))).map((message) => listHeader(message, threads));

export const searchDocuments = (state: State, messages: Message[]) => visibleGroup(state, messages.map(searchDocument));

export const retainedSpam = (state: State, message: Message) => state.account !== null && state.senderActions.isRetainedSpam(state.account.email, state.folder, message);

export function refreshSenderView(state: State) {
  for (const message of visibleGroup(state, [...state.messages, ...state.senderPane.messages()])) {
    const card = state.cards.get(message.uid);
    if (card) card.update(message);
  }
  renderList(state);
}

const TRASH = ["trash", "bin", "deleted items", "deleted messages"];
const SPAM = ["spam", "junk", "junk mail", "junk e-mail"];

export function menuActionsForMessages(folder: string, targeted: Message[]) {
  const actions: SenderAction[] = [{ kind: "MarkRead" }, { kind: "MarkUnread" }];
  if (targeted.some((message) => !message.isFlagged)) actions.push({ kind: "Star" });
  if (targeted.some((message) => message.isFlagged)) actions.push({ kind: "Unstar" });
  actions.push({ kind: "MoveTo", folder: "" });
  const leaf = folder.toLowerCase().replace(/^.*[/.]/s, "");
  const trash = TRASH.includes(leaf);
  if (trash) actions.push({ kind: "Restore" });
  actions.push(trash || SPAM.includes(leaf) || targeted.some((message) => message.isSpam) ? { kind: "Unspam" } : { kind: "Spam" });
  actions.push({ kind: "Archive" }, { kind: "Delete" });
  return actions;
}
