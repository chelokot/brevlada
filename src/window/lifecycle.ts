import type Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import type { Compose } from "../components/compose";
import type { Flag, State } from "./state";

export function flushBeforeClose(state: State, window: Adw.ApplicationWindow, pending: Flag, ready: Flag) {
  const composers = new Set([...state.openComposers, ...state.draftEditors.values()].map(({ compose }) => compose));
  const dirty = [...composers].filter(({ autosave }) => !autosave.paused() && autosave.needsFlush());
  if (dirty.length === 0) return false;
  pending.value = true;
  window.set_sensitive(false);
  const closing = new WeakRef(window);
  flush(dirty, () => {
    pending.value = false;
    const window = closing.deref();
    if (window) window.set_sensitive(true);
    ready.value = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const window = closing.deref();
      if (window) window.close();
      return GLib.SOURCE_REMOVE;
    });
  });
  return true;
}

function flush(composers: Compose[], done: () => void) {
  const compose = composers.pop();
  if (!compose) return done();
  compose.autosave.defer(true, () => {
    compose.autosave.resume();
    flush(composers, done);
  });
}
