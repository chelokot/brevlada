import Gio from "gi://Gio?version=2.0";
import type Gtk from "gi://Gtk?version=4.0";
import { startLoop, stopLoop } from "./loop";

const INACTIVITY_MS = 10_000;

export function run(app: Gtk.Application, argv: string[]) {
  startLoop();
  const service = argv.includes("--gapplication-service");
  if (service) app.flags |= Gio.ApplicationFlags.IS_SERVICE;
  app.register(null);
  if (app.is_remote) {
    app.activate();
    app.get_dbus_connection()?.flush_sync(null);
    stopLoop();
    return Promise.resolve(0);
  }
  let holds = 0;
  let idle: Timer | undefined;
  const { promise, resolve } = Promise.withResolvers<number>();
  const hold = app.hold.bind(app);
  const release = app.release.bind(app);
  const finish = () => {
    clearTimeout(idle);
    app.emit("shutdown");
    stopLoop();
    resolve(0);
  };
  const settle = () => {
    clearTimeout(idle);
    if (holds > 0 || app.get_windows().length > 0) return;
    if (service) idle = setTimeout(finish, INACTIVITY_MS);
    else finish();
  };
  Object.assign(app, {
    hold() {
      holds++;
      hold();
    },
    release() {
      holds--;
      release();
      queueMicrotask(settle);
    },
    quit: finish,
  });
  app.connect("window-removed", () => queueMicrotask(settle));
  app.connect("activate", () => clearTimeout(idle));
  if (service) settle();
  else app.activate();
  return promise;
}
