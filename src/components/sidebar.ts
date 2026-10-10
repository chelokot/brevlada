import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Account } from "../models";
import { address } from "../models/senders";
import { ACCOUNT_AVATAR_SIZE, INDENT, SMALL_SPACING } from "../theme";
import type { Avatars } from "./avatars";
import type { Expansion } from "./expansion";
import { button, column, horizontal, label } from "./index";

export class Unread {
  readonly #folders = new Set<string>();
  readonly labels = new Map<string, Gtk.Label>();

  bind(folder: string, label: Gtk.Label) {
    this.labels.set(folder, label);
    this.#refresh();
  }

  clearFolderLabels() {
    for (const folder of this.labels.keys()) if (folder) this.labels.delete(folder);
  }

  update(folders: [folder: string, unread: boolean][]) {
    for (const [folder, unread] of folders) {
      if (unread) this.#folders.add(folder);
      else this.#folders.delete(folder);
    }
    this.#refresh();
  }

  replace(folders: [folder: string, unread: boolean][]) {
    this.#folders.clear();
    this.update(folders);
  }

  #refresh() {
    for (const [folder, label] of this.labels) {
      const unread = this.#folders.values().some((path) => !folder || path === folder || path.startsWith(`${folder}/`));
      if (unread) label.add_css_class("unread");
      else label.remove_css_class("unread");
    }
  }
}

export class Selection {
  #button: Gtk.Button | null = null;

  activate(button: Gtk.Button) {
    this.#button?.unset_state_flags(Gtk.StateFlags.CHECKED);
    this.#button = button;
    button.set_state_flags(Gtk.StateFlags.CHECKED, false);
  }
}

export class AccountRow {
  readonly widget = column("account-item");
  readonly folders = column("account-folders");

  constructor(account: Account, unread: Unread, expansion: Expansion, avatars: Avatars, selection: Selection, select: () => void, discover: () => void) {
    const row = horizontal("account-container", SMALL_SPACING);
    const expand = button("pan-end-symbolic", "Expand account");
    expand.add_css_class("account-expand");
    row.append(expand);
    const content = horizontal("account-content", SMALL_SPACING);
    const title = account.name || account.email;
    const avatar = Adw.Avatar.new(ACCOUNT_AVATAR_SIZE, title, true);
    avatar.add_css_class("account-avatar");
    avatars.attach(avatar, address(account.email));
    content.append(avatar);
    const name = label(title, "account-text");
    unread.bind("", name);
    content.append(name);
    const accountButton = new Gtk.Button({ child: content, hexpand: true, cssClasses: ["flat", "account-button"] });
    accountButton.connect("clicked", (button) => {
      selection.activate(button);
      select();
    });
    row.append(accountButton);
    this.widget.append(row);
    const folders = this.folders;
    folders.set_visible(false);
    this.widget.append(folders);
    expand.connect("clicked", (button) => {
      const expanded = !folders.get_visible();
      folders.set_visible(expanded);
      button.set_icon_name(expanded ? "pan-down-symbolic" : "pan-end-symbolic");
      if (!expanded || (folders.get_first_child() && !folders.has_css_class("folders-loading"))) return;
      if (!folders.get_first_child()) {
        const loading = label("Loading folders…", "dim-label");
        loading.set_margin_start(INDENT);
        folders.append(loading);
      }
      folders.add_css_class("folders-loading");
      discover();
    });
    if (expansion.isExpanded("")) expand.emit("clicked");
    expansion.bind("", folders);
  }
}

export function folderIcon(name: string) {
  const upper = name.toUpperCase();
  const has = (...words: string[]) => words.some((word) => upper.includes(word));
  if (upper === "INBOX") return "mail-unread-symbolic";
  if (has("SENT", "ITEMS")) return "mail-send-symbolic";
  if (has("DRAFT")) return "document-edit-symbolic";
  if (has("TRASH", "DELETED")) return "user-trash-symbolic";
  if (has("SPAM", "JUNK", "BULK")) return "mail-mark-junk-symbolic";
  if (has("ALL MAIL")) return "mail-unread-symbolic";
  if (has("ARCHIVE")) return "shoe-box-symbolic";
  if (has("IMPORTANT")) return "mail-mark-important-symbolic";
  if (has("STARRED")) return "starred-symbolic";
  return "folder-symbolic";
}
