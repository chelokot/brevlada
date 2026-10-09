import Adw from "gi://Adw?version=1";
import type Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { failure } from "../backend/protocol";
import { SettingsWindow } from "../components/settings";
import type { Message } from "../models";
import { address, key } from "../models/senders";
import { load, save } from "../models/settings";
import { isTrusted } from "./index";
import type { State } from "./state";

export async function connectSettings(state: State, window: Adw.ApplicationWindow, action: Gio.SimpleAction, path: string) {
  let preferences: Adw.PreferencesWindow | null = null;
  let saving = Promise.resolve();
  action.connect("activate", () => {
    if (preferences && Gtk.Window.list_toplevels().includes(preferences)) return preferences.present();
    const settings = new SettingsWindow(window, state.settings.trustAllSenders);
    settings.trustAllSenders.connect("notify::active", (row) => {
      const trustAllSenders = row.get_active();
      state.settings = { ...state.settings, trustAllSenders };
      saving = saving.then(() =>
        load(path)
          .then((stored) => save({ ...stored, trustAllSenders }, path))
          .catch((error: unknown) => {
            console.error(`Could not save settings: ${failure(error)}`);
            state.toast.add_toast(Adw.Toast.new("Could not save settings"));
          }),
      );
      refreshTrust(state);
    });
    preferences = settings.window;
    settings.window.present();
  });
  try {
    state.settings = await load(path);
  } catch (error) {
    console.error(`Could not restore settings: ${failure(error)}`);
  }
  refreshTrust(state);
}

function refreshTrust(state: State) {
  const own = state.account ? address(state.account.email) : null;
  const trusted = (message: Message) => {
    const sender = key(message);
    return own === sender || isTrusted(state, sender);
  };
  for (const message of state.openGroup) {
    const card = state.cards.get(message.uid);
    if (card) card.setTrusted(trusted(message));
  }
  for (const { message } of state.relatedSent) {
    const card = state.sentCards.get(message.messageId);
    if (card) card.setTrusted(trusted(message));
  }
}
