import Gtk from "gi://Gtk?version=4.0";
import { label, messageRow, senderRow } from "../components";
import { identify, item } from "../components/virtual-list";
import { isReply } from "../models/calendar";
import { preview } from "../models/senders";
import { showThread } from "./actions";
import { requestPreview } from "./previews";
import { selectSearchLocation } from "./search";
import { openSearchSender } from "./search-sender";
import { filterSender } from "./sender-pane";
import type { State } from "./state";

export function connectLists(state: State) {
  for (const threads of [false, true]) {
    const list = threads ? state.threadList : state.list;
    const factory = new Gtk.SignalListItemFactory();
    factory.connect("bind", (_factory, object) => {
      const data = object instanceof Gtk.ListItem && item(list, object.get_position());
      if (!data) return;
      const group = data.messages;
      const row = threads ? messageRow(group) : senderRow(group, state.avatars);
      const location = !threads && state.searchLocations.get(data.key);
      if (location) {
        const where = `${location.account} · ${location.folder}`;
        row.set_tooltip_text(where);
        const content = row.get_first_child()?.get_next_sibling();
        if (content instanceof Gtk.Box) {
          const caption = label(state.searchFilters.selectedAccounts().size > 1 ? where : location.folder, "dim-label");
          caption.add_css_class("caption");
          content.append(caption);
        }
      }
      (threads ? state.activeThreadRow : state.activeSenderRow).bind(row, data.key);
      const message = threads && group.find((message) => !isReply(message));
      if (message) requestPreview(state, message);
      identify(row, data.key);
      object.set_child(row);
    });
    factory.connect("unbind", (_factory, object) => {
      if (object instanceof Gtk.ListItem) object.set_child(null);
    });
    list.set_factory(factory);
  }
  state.list.connect("activate", (_list, position) => activateSender(state, position));
  state.threadList.connect("activate", (_list, position) => {
    const row = !state.rendering && item(state.threadList, position);
    if (row) showThread(state, [...row.messages]);
  });
}

export function activateSender(state: State, position: number) {
  const row = !state.rendering && item(state.list, position);
  if (!row) return;
  const message = preview(row.messages);
  const matches = message && message.searchMatch ? [...row.messages] : null;
  if (!selectSearchLocation(state, state.searchLocations.get(row.key) ?? null)) return;
  if (matches) openSearchSender(state, row.key, matches);
  else if (message) filterSender(state, message);
}
