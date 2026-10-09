import { groups, selection } from "../components/virtual-list";
import { key } from "../models/senders";
import { showThread } from "./actions";
import { activateSender } from "./lists";
import { filterSender, loadSenderPage } from "./sender-pane";
import type { State } from "./state";

export function advanceMessage(state: State) {
  if (!state.nextMessage) return;
  const [senderIndex, threadIndex] = state.nextMessage;
  const threads = groups(state.threadList);
  const index = Math.min(threadIndex, threads.length - 1);
  const thread = threads[index];
  if (thread) {
    selection(state.threadList).set_selected(index);
    return showThread(state, [...thread]);
  }
  if (state.senderPane.loading()) return;
  if (state.senderPane.canLoad()) return loadSenderPage(state);
  const current = state.senderPane.sender();
  const candidates = groups(state.list).flatMap((group, index) => {
    const [message] = group;
    return message && key(message) !== current ? [{ index, message }] : [];
  });
  const next = candidates.find(({ index }) => index >= senderIndex) ?? candidates.at(-1);
  if (!next) {
    state.nextMessage = null;
    return filterSender(state, null);
  }
  if (next.message.searchMatch) return activateSender(state, next.index);
  filterSender(state, next.message);
  state.nextMessage = [next.index, 0];
}
