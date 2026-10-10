import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import mailRead from "../resources/brevlada-mail-read-symbolic.svg" with { type: "text" };
import paperPlane from "../resources/paper-plane-symbolic.svg" with { type: "text" };
import person from "../resources/person-symbolic.svg" with { type: "text" };
import shoeBox from "../resources/shoe-box-symbolic.svg" with { type: "text" };
import ticket from "../resources/ticket-symbolic.svg" with { type: "text" };
import truck from "../resources/truck-symbolic.svg" with { type: "text" };
import { Engine } from "./application";
import { Background } from "./background";
import { run } from "./gi";
import { create } from "./window";

const icons = {
  "shoe-box-symbolic": shoeBox,
  "brevlada-mail-read-symbolic": mailRead,
  "paper-plane-symbolic": paperPlane,
  "truck-symbolic": truck,
  "ticket-symbolic": ticket,
  "person-symbolic": person,
};

function installIcons(display: Gdk.Display) {
  const directory = join(GLib.get_user_cache_dir(), "brevlada", "icons");
  mkdirSync(directory, { recursive: true });
  for (const [name, svg] of Object.entries(icons)) writeFileSync(join(directory, `${name}.svg`), svg);
  Gtk.IconTheme.get_for_display(display).add_search_path(directory);
}

GLib.set_prgname("brevlada");
const app = new Adw.Application({ applicationId: "io.github.ExposedCat.Brevlada" });
let engine: Engine | null = null;
let background: Background | null = null;
app.connect("startup", (app) => {
  const display = Gdk.Display.get_default();
  if (display) installIcons(display);
  engine = new Engine(app);
  background = new Background(app, engine);
});
app.connect("activate", (app) => {
  const window = app.get_windows().find((window) => window instanceof Adw.ApplicationWindow);
  if (window) window.present();
  else if (engine) create(app, engine);
});
let quitting = false;
app.connect("window-removed", (app) => {
  if (quitting && app.get_windows().length === 0) app.quit();
});
const quit = new Gio.SimpleAction({ name: "quit" });
quit.connect("activate", () => {
  quitting = true;
  const windows = app.get_windows();
  if (windows.length === 0) app.quit();
  for (const window of windows) window.close();
});
app.add_action(quit);
app.set_accels_for_action("app.quit", ["<Primary>q"]);
const open = new Gio.SimpleAction({ name: "open-message", parameterType: new GLib.VariantType("(suu)") });
open.connect("activate", (_action, target) => {
  if (!target) return;
  const [account, validity, uid] = target.deepUnpack<[string, number, number]>();
  app.activate();
  app.withdraw_notification(`new-mail-${account}`);
  if (engine) engine.worker.send({ type: "OpenNotification", account, validity, uid });
});
app.add_action(open);
app.connect("shutdown", () => {
  if (background) background.stop();
  if (engine) engine.stop();
  background = engine = null;
});
process.exit(await run(app, process.argv.slice(1)));
