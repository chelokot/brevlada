import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { encode, MAX_BYTES } from "../backend/attachments";
import { attachmentName, parseMail } from "../backend/mime";
import type { Draft } from "../models";
import { SMALL_SPACING } from "../theme";
import { cancelled, FileCard, grid } from "./attachments";
import { button, column, horizontal, label } from "./index";

interface Item {
  name: string;
  size: number | null;
  part: string | null;
  source: number | null;
}

const encoder = new TextEncoder();

const attempt = <T>(run: () => T) => {
  try {
    return run();
  } catch {
    return null;
  }
};

const parsed = (part: string) => attempt(() => parseMail(encoder.encode(part)));

const total = (items: Item[]) => items.reduce((sum, { size }) => sum + (size ?? 0), 0);

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

export class Attachments {
  readonly widget = column("attachment-section");
  readonly toolbar = horizontal("attachment-toolbar", SMALL_SPACING);
  readonly #grid = grid();
  readonly #button: Gtk.Button;
  readonly #status = label("", "dim-label");
  #items: Item[] = [];
  #removed: number[] = [];
  #loading = false;
  #revision = 0;
  #onLoading = (_loading: boolean) => {};
  #onChanged = () => {};
  #loaded = true;
  #inline: string[] = [];

  constructor() {
    this.widget.append(this.#grid);
    const content = horizontal("attachment-button-content", SMALL_SPACING);
    content.append(Gtk.Image.new_from_icon_name("mail-attachment-symbolic"));
    content.append(Gtk.Label.new("Attach files"));
    this.#button = new Gtk.Button({ child: content, tooltipText: "Attach files (up to 20 MB total)" });
    this.toolbar.append(this.#button);
    this.toolbar.append(this.#status);
    this.#button.connect("clicked", (clicked) => {
      const root = clicked.get_root();
      this.#pick(root instanceof Gtk.Window ? root : null);
    });
    this.#render();
  }

  load(draft: Draft) {
    this.clear();
    this.#loaded = draft.attachmentsLoaded;
    this.#items.push(...draft.attachmentNames.map((name, source) => ({ name, size: null, part: null, source })));
    for (const part of draft.attachments) {
      const mail = parsed(part);
      if (mail === null) continue;
      this.#items.push({ name: attachmentName(mail) ?? "Attachment", size: attempt(() => mail.bodyRaw().length), part, source: null });
    }
    this.#render();
  }

  clear() {
    this.#revision++;
    this.#items = [];
    this.#removed = [];
    this.#inline = [];
    this.#loaded = true;
    this.#render();
  }

  connectChanged(action: () => void) {
    this.#onChanged = action;
  }

  loaded() {
    return this.#loaded;
  }

  resolve(parts: string[]) {
    if (this.#loaded) return;
    this.#loaded = true;
    const originals: string[] = [];
    for (const part of parts) {
      const mail = parsed(part);
      if (mail !== null) (attachmentName(mail) === null ? this.#inline : originals).push(part);
    }
    for (const item of this.#items) {
      if (item.source === null) continue;
      item.part = originals[item.source] ?? null;
      item.source = null;
    }
    this.#removed = [];
    this.#render();
  }

  connectLoading(action: (loading: boolean) => void) {
    this.#onLoading = action;
  }

  loading() {
    return this.#loading;
  }

  parts() {
    return [...this.#items.flatMap(({ part }) => (part === null ? [] : [part])), ...this.#inline];
  }

  removed() {
    return [...this.#removed];
  }

  names() {
    return this.#items.filter(({ source }) => source !== null).map(({ name }) => name);
  }

  #render() {
    this.#grid.remove_all();
    this.#items.forEach((item, index) => {
      const card = new FileCard(item.name, item.size);
      const remove = button("window-close-symbolic", `Remove ${item.name}`);
      remove.connect("clicked", () => {
        this.#items.splice(index, 1);
        if (item.source !== null) this.#removed.push(item.source);
        this.#render();
        this.#onChanged();
      });
      card.actions.append(remove);
      this.#grid.append(card.widget);
    });
    const count = this.#items.length;
    this.widget.set_visible(count > 0);
    const unknown = this.#items.some(({ size }) => size === null);
    this.#status.set_text(count === 0 ? "Up to 20 MB total" : unknown ? fileCount(count) : `${fileCount(count)} · ${GLib.format_size(total(this.#items))}`);
  }

  async #pick(parent: Gtk.Window | null) {
    if (this.#loading) return;
    this.#loading = true;
    this.#button.set_sensitive(false);
    this.#onLoading(true);
    const revision = this.#revision;
    const dialog = new Gtk.FileDialog({ title: "Attach files", acceptLabel: "Attach" });
    const files = await dialog.open_multiple(parent, null).catch((error: GLib.Error) => error);
    if (files instanceof GLib.Error) {
      if (!cancelled(files)) this.#status.set_text(`Could not choose files: ${files.message}`);
    } else {
      for (let position = 0; position < files.get_n_items(); position++) {
        const file = files.get_item(position);
        if (!(file instanceof Gio.File)) continue;
        this.#status.set_text("Reading attachment…");
        const item = await this.#read(file).catch((error: Error) => error);
        if (item instanceof Error) {
          this.#status.set_text(item.message);
          break;
        }
        if (this.#revision !== revision) break;
        this.#items.push(item);
        this.#render();
      }
    }
    this.#loading = false;
    this.#button.set_sensitive(true);
    this.#onLoading(false);
  }

  async #read(file: Gio.File): Promise<Item> {
    const info = await file.query_info_async(
      "standard::name,standard::size,standard::type,standard::content-type",
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
    );
    if (info.get_file_type() !== Gio.FileType.REGULAR) throw new Error("Choose a regular file");
    const used = total(this.#items);
    if (used + info.get_size() > MAX_BYTES) throw new Error("Attachments exceed the 20 MB total limit");
    const [bytes] = await file.load_contents_async(null);
    if (used + bytes.length > MAX_BYTES) throw new Error("Attachments exceed the 20 MB total limit");
    const name = info.get_name();
    const contentType = info.get_content_type();
    const mime = (contentType === null ? null : Gio.content_type_get_mime_type(contentType)) ?? "application/octet-stream";
    return { name, size: bytes.length, part: encode(name, mime, bytes), source: null };
  }
}
