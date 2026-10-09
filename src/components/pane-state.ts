import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import type Gtk from "gi://Gtk?version=4.0";
import { LIST_WIDTH, SIDEBAR_WIDTH, WINDOW_WIDTH } from "../theme";
import type { Sidebar } from "./motion";

interface PaneState {
  sidebar_width: number;
  sender_width: number;
  thread_width: number;
  maximized: boolean;
}

const defaults = (): PaneState => ({ sidebar_width: SIDEBAR_WIDTH, sender_width: LIST_WIDTH, thread_width: LIST_WIDTH, maximized: false });
const isInt = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= -(2 ** 31) && Number(value) < 2 ** 31;
const isFloat = (value: unknown): value is number => typeof value === "number";
const isFlag = (value: unknown): value is boolean | undefined => value === undefined || typeof value === "boolean";
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function load(path: string): PaneState {
  if (!existsSync(path)) return defaults();
  const saved: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
  const { sidebar_width, sender_width, thread_width, maximized, sidebar_fraction, messages_fraction, threads_fraction, sidebar_collapsed, sidebar, messages } = saved;
  if (isInt(sidebar_width) && isInt(sender_width) && isInt(thread_width) && isFlag(maximized)) {
    return { sidebar_width, sender_width, thread_width, maximized: maximized === true };
  }
  const threads = threads_fraction === undefined || threads_fraction === null ? null : threads_fraction;
  if (isFloat(sidebar_fraction) && isFloat(messages_fraction) && (threads === null || isFloat(threads)) && isFlag(maximized) && isFlag(sidebar_collapsed)) {
    const sidebarWidth = Math.round(sidebar_fraction * WINDOW_WIDTH);
    const remaining = WINDOW_WIDTH - (sidebar_collapsed ? 0 : sidebarWidth);
    const senderWidth = Math.round(messages_fraction * remaining);
    const threadWidth = threads === null ? LIST_WIDTH : Math.round(threads * (remaining - senderWidth));
    return { sidebar_width: sidebarWidth, sender_width: senderWidth, thread_width: threadWidth, maximized: maximized === true };
  }
  if (isInt(sidebar) && isInt(messages)) return { ...defaults(), sidebar_width: sidebar, sender_width: messages };
  throw new Error("data did not match any variant of untagged enum SavedState");
}

export function remember(window: Adw.ApplicationWindow, sidebar: Sidebar, messages: Gtk.Paned, threads: Sidebar) {
  const path = join(GLib.get_user_config_dir(), "brevlada/layout.json");
  let state = defaults();
  try {
    state = load(path);
  } catch (error) {
    console.error(`Could not restore window layout: ${reason(error)}`);
  }
  if (state.maximized) window.maximize();
  sidebar.restoreWidth(state.sidebar_width);
  messages.set_position(Math.max(state.sender_width, 1));
  threads.restoreWidth(state.thread_width);
  window.connect("close-request", (window) => {
    const current: PaneState = { sidebar_width: sidebar.width(), sender_width: Math.max(messages.get_position(), 1), thread_width: threads.width(), maximized: window.is_maximized() };
    try {
      mkdirSync(dirname(path), { recursive: true });
      GLib.file_set_contents(path, JSON.stringify(current));
    } catch (error) {
      console.error(`Could not save window layout: ${reason(error)}`);
    }
    return false;
  });
}
