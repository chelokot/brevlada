import { afterEach } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Command } from "../backend/protocol";
import { MailWorker } from "../backend/worker";
import { Avatars } from "../components/avatars";
import { Expansion } from "../components/expansion";
import { createShell } from "../components/shell";
import { useDisplay } from "../components/testing";
import type { Account } from "../models";
import { createState } from "./index";
import type { State } from "./state";

export const account = (email: string): Account => ({ path: "", email, name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null });

const states: State[] = [];
const apps: Adw.Application[] = [];

export function useWindows() {
  useDisplay();
  afterEach(() => {
    for (const state of states.splice(0)) state.searchWorker.stop();
    for (const toplevel of Gtk.Window.list_toplevels()) if (toplevel instanceof Gtk.Window) toplevel.destroy();
    for (const app of apps.splice(0)) for (const name of app.list_actions()) app.remove_action(name);
  });
}

export function testState(id: string, avatars = new Avatars(() => {})) {
  const app = new Adw.Application({ applicationId: `org.example.Brevlada${id}Diagnostic`, flags: Gio.ApplicationFlags.NON_UNIQUE });
  app.register(null);
  apps.push(app);
  const shell = createShell(app);
  const [worker, commands] = MailWorker.recording();
  const state = createState(shell, worker, new Expansion(), avatars);
  states.push(state);
  return { state, window: shell.window, commands, app, settings: shell.settings };
}

export function inbox(id: string, email = "account@example.com") {
  const test = testState(id);
  test.state.account = account(email);
  test.state.folder = "INBOX";
  return test;
}

const background = new Set<Command["type"]>(["Register", "RetainAccounts", "Avatar", "Expanded", "Focus", "Select", "Body"]);

export function next(commands: Command[]) {
  for (let command = commands.shift(); command; command = commands.shift()) if (!background.has(command.type)) return command;
  return null;
}

const typed =
  <T extends Command["type"]>(type: T) =>
  (command: Command | null): command is Extract<Command, { type: T }> =>
    command !== null && command.type === type;

export async function command<T extends Command["type"]>(commands: Command[], type: T) {
  const deadline = performance.now() + 10_000;
  while (commands.every((command) => background.has(command.type)) && performance.now() < deadline) await Bun.sleep(10);
  const found = next(commands);
  if (!typed(type)(found)) throw new Error(`Expected ${type} command, got ${found ? found.type : "none"}`);
  return found;
}

export function senderTicket(state: State) {
  if (!state.senderPane.loading()) state.senderPane.request();
  return state.senderPane.ticket();
}

export function searchBar(entry: Gtk.SearchEntry) {
  const bar = entry.get_ancestor(Gtk.SearchBar.$gtype);
  if (!(bar instanceof Gtk.SearchBar)) throw new Error("Search entries belong to a search bar");
  return bar;
}

export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}

export function widget<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  if (!(value instanceof type)) throw new Error(`Expected ${type.name}`);
  return value;
}
