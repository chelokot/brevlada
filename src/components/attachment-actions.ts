import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { load } from "../backend/attachment-cache";
import { download } from "../backend/attachments";
import type { Account, Message } from "../models";
import { safeName } from "../models/attachment";
import { ATTACHMENT_ICON_SIZE } from "../theme";
import { type FileCard, cancelled } from "./attachments";
import { button } from "./index";
import { openFile } from "./links";

export function attach(card: FileCard, name: string, account: Account | null, folder: string, message: Message, index: number) {
  const open = card.openButton(name);
  const save = button("folder-download-symbolic", `Save ${name} elsewhere`);
  const indicator = new Gtk.Stack();
  const spinner = new Gtk.Spinner({ widthRequest: ATTACHMENT_ICON_SIZE, heightRequest: ATTACHMENT_ICON_SIZE });
  indicator.add_named(Gtk.Image.new_from_icon_name("folder-download-symbolic"), "icon");
  indicator.add_named(spinner, "spinner");
  indicator.set_visible_child_name("icon");
  save.set_child(indicator);
  card.actions.append(save);
  open.set_sensitive(account !== null);
  save.set_sensitive(account !== null);
  if (account === null) return;
  const subtitle = card.status.get_text();
  let busy = false;
  const enable = (enabled: boolean) => {
    open.set_sensitive(enabled);
    save.set_sensitive(enabled);
  };
  const spinning = (active: boolean) => {
    spinner.set_spinning(active);
    indicator.set_visible_child_name(active ? "spinner" : "icon");
  };
  const status = (text: string) => {
    card.status.set_text(text);
    card.status.set_tooltip_text(text);
  };
  const cached = () =>
    load(account, folder, message, index, () => {
      spinning(true);
      status("Downloading…");
      return download(account, folder, message, index);
    });
  const perform = async (window: Gtk.Window | null, opening: boolean) => {
    let destination: Gio.File | null = null;
    if (!opening) {
      const dialog = new Gtk.FileDialog({ title: "Save attachment", initialName: safeName(name) });
      try {
        destination = await dialog.save(window, null);
      } catch (error) {
        if (error instanceof GLib.Error && cancelled(error)) return;
        throw error;
      }
    }
    const path = await cached();
    if (destination) {
      const source = Gio.File.new_for_path(path);
      if (!source.equal(destination)) {
        spinning(true);
        status("Saving…");
        await source.copy_async(destination, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
      }
      status("Saved");
      return;
    }
    spinning(false);
    status(subtitle);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    openFile(path, window, (result) => (result.ok ? resolve() : reject(new Error(result.error))));
    await promise;
  };
  const start = (clicked: Gtk.Button, opening: boolean) => {
    if (busy) return;
    busy = true;
    enable(false);
    status(subtitle);
    const root = clicked.get_root();
    perform(root instanceof Gtk.Window ? root : null, opening)
      .catch((error: Error) => status(`Could not ${opening ? "open attachment" : "save attachment"}: ${error.message}`))
      .finally(() => {
        spinning(false);
        busy = false;
        enable(true);
      });
  };
  open.connect("clicked", (clicked) => start(clicked, true));
  save.connect("clicked", (clicked) => start(clicked, false));
}
