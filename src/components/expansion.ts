import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import GLib from "gi://GLib?version=2.0";
import type Gtk from "gi://Gtk?version=4.0";

type Accounts = Map<string, Set<string>>;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function read(path: string): Accounts {
  if (!existsSync(path)) return new Map();
  const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new Error("invalid type: expected a map");
  return new Map(
    Object.entries(saved).map(([account, folders]) => {
      if (!Array.isArray(folders) || !folders.every((folder) => typeof folder === "string")) throw new Error("invalid type: expected a sequence of strings");
      return [account, new Set(folders)];
    }),
  );
}

export class Expansion {
  constructor(
    private readonly accounts: Accounts = new Map(),
    private readonly path: string | null = null,
    private readonly account = "",
  ) {}

  static load() {
    return Expansion.loadFrom(join(GLib.get_user_config_dir(), "brevlada/expansion.json"));
  }

  static loadFrom(path: string) {
    try {
      return new Expansion(read(path), path);
    } catch (error) {
      console.error(`Could not restore expanded folders: ${reason(error)}`);
      return new Expansion(new Map(), path);
    }
  }

  forAccount(account: string) {
    return new Expansion(this.accounts, this.path, account);
  }

  isExpanded(folder: string) {
    return this.accounts.get(this.account)?.has(folder) === true;
  }

  bind(folder: string, children: Gtk.Box) {
    children.set_visible(this.isExpanded(folder));
    children.connect("notify::visible", (children) => this.set(folder, children.get_visible()));
  }

  set(folder: string, expanded: boolean) {
    const folders = this.accounts.get(this.account) ?? new Set();
    this.accounts.set(this.account, folders);
    if (expanded) folders.add(folder);
    else folders.delete(folder);
    if (this.path === null) return;
    const sorted = Object.fromEntries([...this.accounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([account, folders]) => [account, [...folders].sort()]));
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      GLib.file_set_contents(this.path, JSON.stringify(sorted));
    } catch (error) {
      console.error(`Could not save expanded folders: ${reason(error)}`);
    }
  }
}
