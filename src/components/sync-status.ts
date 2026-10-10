import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import type { Count, Status } from "../models/sync";
import { ROW_GAP } from "../theme";
import { horizontal, label } from "./index";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

class Counter {
  readonly widget = horizontal("sync-counter", ROW_GAP);
  readonly #label = label("", "sync-counter-label");

  constructor(
    icon: string,
    private readonly kind: string,
  ) {
    this.widget.set_visible(false);
    this.widget.append(label("·", "dim-label"));
    this.#label.set_hexpand(false);
    this.#label.set_ellipsize(Pango.EllipsizeMode.NONE);
    this.widget.append(this.#label);
    this.widget.append(Gtk.Image.new_from_icon_name(icon));
  }

  update(count: Count | null) {
    this.widget.set_visible(count !== null);
    if (count === null) return;
    this.#label.set_label(`${count.cached}/${count.total}`);
    this.widget.set_tooltip_text(`${count.cached} of ${count.total} ${this.kind} cached for this sync`);
  }
}

export class SyncStatus {
  readonly widget = horizontal("sync-status", ROW_GAP);
  readonly #spinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER, visible: false });
  readonly #label = label("Last synced: —", "sync-status-label");
  readonly #accounts = new Counter("avatar-default-symbolic", "accounts");
  readonly #folders = new Counter("folder-symbolic", "folders");
  readonly #messages = new Counter("mail-unread-symbolic", "messages");

  constructor() {
    this.widget.set_halign(Gtk.Align.CENTER);
    this.#label.set_max_width_chars(24);
    this.#label.set_hexpand(false);
    for (const child of [this.#spinner, this.#label, this.#accounts.widget, this.#folders.widget, this.#messages.widget]) this.widget.append(child);
  }

  update(status: Status) {
    const [text, tooltip] = presentation(status, Date.now() / 1000);
    const progress = status.activity?.progress;
    this.#spinner.set_spinning(status.activity !== null);
    this.#spinner.set_visible(status.activity !== null);
    if (this.#label.get_text() !== text) this.#label.set_label(text);
    this.#accounts.update(progress ? progress.accounts : null);
    this.#folders.update(progress ? progress.folders : null);
    this.#messages.update(progress ? progress.messages : null);
    this.widget.set_tooltip_text(tooltip);
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

function started(at: number) {
  const date = new Date(at * 1000);
  return `${MONTHS[date.getMonth()]} ${pad(date.getDate())}, ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function ago(seconds: number) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function presentation({ activity, active, queued, failed, lastStarted }: Status, now: number): [text: string, tooltip: string] {
  if (activity !== null) {
    const lines = [activity.description, ...(activity.folder ? [activity.folder] : []), `${active} active, ${queued} queued`];
    if (failed > 0) lines.push(`${failed} failed; will retry on the next sync`);
    return ["Syncing", lines.join("\n")];
  }
  const lines = [lastStarted === null ? "No background sync has started yet." : `Last sync started: ${started(lastStarted)}`];
  if (failed > 0) lines.push(`${failed} sync requests failed. They will retry automatically.`);
  const text = lastStarted === null ? "Last synced: —" : `Last synced: ${ago(Math.max(Math.floor(now - lastStarted), 0))}`;
  return [text, lines.join("\n")];
}
