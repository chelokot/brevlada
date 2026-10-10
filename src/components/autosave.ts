import GLib from "gi://GLib?version=2.0";
import type { Result } from "../backend/protocol";
import { DRAFT_SAVE_SECONDS } from "../theme";
import { label } from "./index";

export class Autosave {
  readonly status = label("", "dim-label");
  #revision = 0;
  #saved = 0;
  #saving = 0;
  #busy = false;
  #paused = false;
  #flush = false;
  #timer: number | null = null;
  #action: (() => void) | null = null;
  #deferred: (() => void) | null = null;

  constructor() {
    this.status.set_visible(false);
  }

  connect(action: () => void) {
    this.#action = action;
  }

  changed() {
    this.#revision++;
    if (!this.#paused && !this.#busy) this.#schedule();
  }

  #schedule() {
    this.status.set_visible(true);
    this.status.set_text("Unsaved changes");
    this.#cancelTimer();
    const autosave = new WeakRef(this);
    this.#timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAFT_SAVE_SECONDS * 1000, () => {
      const self = autosave.deref();
      if (self) {
        self.#timer = null;
        self.#start();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  #start() {
    if (this.#busy || this.#saved === this.#revision || !this.#action) return;
    this.#busy = true;
    this.#saving = this.#revision;
    this.status.set_visible(true);
    this.status.set_text("Saving draft…");
    this.#action();
  }

  capture() {
    this.#saving = this.#revision;
  }

  complete(result: Result<unknown>) {
    this.#busy = false;
    if (result.ok) {
      this.#saved = this.#saving;
      this.status.set_text("Draft saved");
      if (this.#flush && this.#saved !== this.#revision) return this.#start();
    } else {
      this.status.set_text(`Could not save draft: ${result.error}`);
      if (this.#flush) {
        this.#deferred = null;
        this.#paused = false;
        return;
      }
    }
    const deferred = this.#deferred;
    this.#deferred = null;
    if (deferred) deferred();
    else if (!this.#paused && this.#saved !== this.#revision && (result.ok || this.#revision !== this.#saving)) this.#schedule();
  }

  defer(flush: boolean, action: () => void) {
    if (this.#paused) return;
    this.#paused = true;
    this.#cancelTimer();
    this.#flush = flush;
    this.#deferred = action;
    if (this.#busy) return;
    if (flush && this.#saved !== this.#revision && this.#action) this.#start();
    else {
      this.#deferred = null;
      action();
    }
  }

  paused() {
    return this.#paused;
  }

  needsFlush() {
    return this.#busy || this.#saved !== this.#revision;
  }

  resume() {
    this.#paused = false;
    this.#flush = false;
    if (this.#saved !== this.#revision) this.#schedule();
  }

  reset() {
    this.#cancelTimer();
    this.#saved = this.#revision;
    this.status.set_text("");
    this.status.set_visible(false);
  }

  #cancelTimer() {
    if (this.#timer !== null) GLib.source_remove(this.#timer);
    this.#timer = null;
  }
}
