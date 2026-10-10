import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import { failure } from "../backend/protocol";
import type { State } from "./state";

interface SortPreferences {
  sendersUnreadFirst: boolean;
  messagesUnreadFirst: boolean;
}

const defaults = (): SortPreferences => ({ sendersUnreadFirst: true, messagesUnreadFirst: true });

function flag(data: object, key: string) {
  const value: unknown = Reflect.get(data, key);
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error(`invalid type: expected a boolean for \`${key}\``);
  return value;
}

export function loadSortPreferences(path: string): SortPreferences {
  if (!existsSync(path)) return defaults();
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("invalid type: expected struct SortPreferences");
  return { sendersUnreadFirst: flag(data, "senders_unread_first"), messagesUnreadFirst: flag(data, "messages_unread_first") };
}

function save({ sendersUnreadFirst, messagesUnreadFirst }: SortPreferences, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  GLib.file_set_contents(path, JSON.stringify({ senders_unread_first: sendersUnreadFirst, messages_unread_first: messagesUnreadFirst }));
}

export function rememberSorting(state: State, path: string) {
  let preferences = defaults();
  try {
    preferences = loadSortPreferences(path);
  } catch (error) {
    console.error(`Could not restore sorting options: ${failure(error)}`);
  }
  state.senderUnreadFirst.setUnreadFirst(preferences.sendersUnreadFirst);
  state.threadUnreadFirst.setUnreadFirst(preferences.messagesUnreadFirst);
  for (const menu of [state.senderUnreadFirst, state.threadUnreadFirst])
    menu.connectChanged(() => {
      try {
        save({ sendersUnreadFirst: state.senderUnreadFirst.unreadFirst(), messagesUnreadFirst: state.threadUnreadFirst.unreadFirst() }, path);
      } catch (error) {
        console.error(`Could not save sorting options: ${failure(error)}`);
        state.toast.add_toast(Adw.Toast.new("Could not save sorting options"));
      }
    });
}
