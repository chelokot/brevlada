import { expect, test } from "bun:test";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./application";
import type { Delivered } from "./backend/worker";
import { Storage } from "./backend/storage";
import { message } from "./models";

const ACCOUNT = "me@example.com";
const flags = (uids: number[]) => uids.map((uid) => ({ uid, read: uid === 1, flagged: false, draft: false }));

async function scenario(enabled: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-engine-"));
  const path = join(directory, "cache.db");
  const storage = Storage.open(path);
  storage.inventory(ACCOUNT, "INBOX", 1, flags([1]));
  storage.inventory(ACCOUNT, "INBOX", 1, flags([1, 2]));
  storage.storeHeaders(ACCOUNT, "INBOX", 1, [message({ uid: 1, isRead: true }), message({ uid: 2, sender: "ada@example.com", subject: "Hello" })]);
  expect(storage.pendingNotifications(ACCOUNT, "INBOX", 1).map((pending) => pending.uid)).toEqual([2]);
  const app = new Gio.Application({ applicationId: `io.github.ExposedCat.Brevlada.Test${enabled ? "Enabled" : "Disabled"}`, flags: Gio.ApplicationFlags.NON_UNIQUE });
  app.register(null);
  const action = Gio.SimpleAction.new_stateful("background", null, GLib.Variant.new_boolean(true));
  action.set_enabled(enabled);
  app.add_action(action);
  const notifications: string[] = [];
  app.send_notification = (id: string | null) => void notifications.push(String(id));
  const engine = new Engine(app, path);
  const events: Delivered[] = [];
  let opened = Promise.withResolvers<void>();
  engine.attach((event) => {
    events.push(event);
    if (event.type === "NotificationOpened") opened.resolve();
  });
  const roundTrip = async () => {
    opened = Promise.withResolvers();
    engine.worker.send({ type: "OpenNotification", account: ACCOUNT, validity: 1, uid: 1 });
    await opened.promise;
  };
  engine.flushNotifications();
  await roundTrip();
  await roundTrip();
  const pending = storage.pendingNotifications(ACCOUNT, "INBOX", 1).map((item) => item.uid);
  engine.stop();
  storage.close();
  rmSync(directory, { recursive: true });
  return { pending, notifications, forwarded: events.filter((event) => event.type === "NewMail") };
}

test("acknowledges new mail without notifying accounts it does not know", async () => {
  expect(await scenario(true)).toEqual({ pending: [], notifications: [], forwarded: [] });
});

test("leaves new mail pending while the background setting is changing", async () => {
  expect(await scenario(false)).toEqual({ pending: [2], notifications: [], forwarded: [] });
});
