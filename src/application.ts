import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { MailWorker, type Delivered } from "./backend/worker";
import { load, save } from "./models/settings";
import { SYNC_SECONDS } from "./theme";

const settingsPath = () => GLib.build_filenamev([GLib.get_user_config_dir(), "brevlada", "settings.json"]);

export const settings = () => load(settingsPath());

export async function saveBackground(enabled: boolean) {
  const path = settingsPath();
  await save({ ...(await load(path)), backgroundService: enabled }, path);
}

export class Engine {
  readonly worker: MailWorker;
  #listener: ((event: Delivered) => void) | null = null;
  #timer: Timer;
  #notified = new Set<string>();
  #accounts = new Set<string>();

  constructor(
    readonly app: Gio.Application,
    path = GLib.build_filenamev([GLib.get_user_data_dir(), "brevlada", "emails.db"]),
  ) {
    this.worker = MailWorker.start(path, (event) => this.#event(event));
    this.#timer = setInterval(() => {
      this.worker.send({ type: "Discover" });
      this.worker.sync();
    }, SYNC_SECONDS * 1000);
    this.worker.send({ type: "Discover" });
  }

  attach(listener: (event: Delivered) => void) {
    this.#listener = listener;
  }

  detach() {
    this.#listener = null;
    this.worker.select(this.worker.nextRequest());
  }

  stop() {
    this.detach();
    clearInterval(this.#timer);
    this.worker.stop();
  }

  flushNotifications() {
    this.worker.send({ type: "FlushNotifications" });
  }

  #event(event: Delivered) {
    if (event.type === "Accounts") {
      this.worker.retainAccounts(event.accounts);
      this.#accounts = new Set(event.accounts.map((account) => account.email));
      for (const account of event.accounts) this.worker.register(account, false);
    } else if (event.type === "SidebarReady" && !this.#listener) this.worker.sync();
    if (event.type !== "NewMail") {
      if (this.#listener) this.#listener(event);
      return;
    }
    const { account, folder, validity, messages } = event;
    if (!this.app.get_action_enabled("background")) return;
    const fresh = messages.filter(({ uid }) => {
      const id = JSON.stringify([account, folder, validity, uid]);
      const unseen = !this.#notified.has(id);
      this.#notified.add(id);
      return unseen;
    });
    const [first] = fresh;
    if (first && this.#accounts.has(account) && this.app.get_action_state("background")?.get_boolean()) {
      const single = fresh.length === 1;
      const notification = Gio.Notification.new(single ? first.sender : `${fresh.length} new messages`);
      notification.set_body(single ? first.subject : account);
      notification.set_icon(Gio.ThemedIcon.new("io.github.ExposedCat.Brevlada-symbolic"));
      notification.set_default_action_and_target("app.open-message", new GLib.Variant("(suu)", [account, validity, first.uid]));
      this.app.send_notification(`new-mail-${account}`, notification);
    }
    this.worker.send({ type: "NotificationsHandled", account, folder, validity, uids: messages.map((message) => message.uid) });
  }
}
