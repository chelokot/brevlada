import { existsSync } from "node:fs";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { saveBackground, settings, type Engine } from "../application";
import { failure } from "../backend/protocol";
import * as portal from "./portal";

export class Background {
  readonly #action = Gio.SimpleAction.new_stateful("background", null, GLib.Variant.new_boolean(false));
  #held = false;

  constructor(
    readonly app: Gio.Application,
    readonly engine: Engine,
  ) {
    app.add_action(this.#action);
    this.#action.connect("change-state", (_action, value) => {
      if (value) void this.#change(value.get_boolean());
    });
    app.hold();
    void settings()
      .then(async ({ backgroundService }) => {
        if (backgroundService) await this.#change(true);
      })
      .catch(() => {})
      .finally(() => app.release());
  }

  stop() {
    this.#release();
  }

  async #change(enabled: boolean) {
    if (!this.#action.get_enabled()) return;
    this.#action.set_enabled(false);
    const previous = this.#action.get_state()?.get_boolean() === true;
    this.#action.set_state(GLib.Variant.new_boolean(enabled));
    this.app.hold();
    const sandboxed = existsSync("/.flatpak-info");
    try {
      if (sandboxed && enabled) await portal.request();
      await saveBackground(enabled);
      this.#action.set_state(GLib.Variant.new_boolean(enabled));
      if (enabled) {
        if (!this.#held) this.app.hold();
        this.#held = true;
        if (sandboxed) await portal.status().catch((error) => console.error(`Could not report background status: ${failure(error)}`));
      } else this.#release();
    } catch (error) {
      this.#action.set_state(GLib.Variant.new_boolean(previous));
      await saveBackground(previous).catch((problem) => console.error(`Could not restore background setting: ${failure(problem)}`));
      console.error(`Could not change background service: ${failure(error)}`);
      const notification = Gio.Notification.new("Could not change background service");
      notification.set_body(failure(error));
      this.app.send_notification("background-error", notification);
    }
    this.#action.set_enabled(true);
    this.engine.flushNotifications();
    this.app.release();
  }

  #release() {
    if (this.#held) this.app.release();
    this.#held = false;
  }
}
