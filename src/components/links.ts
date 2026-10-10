import { existsSync } from "node:fs";
import Gio from "gi://Gio?version=2.0";
import type GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";

const distrobox = () => process.env["DISTROBOX_ENTER_PATH"] !== undefined && existsSync("/usr/bin/distrobox-host-exec");
const spawn = (target: string) => Promise.try(() => Gio.Subprocess.new(command(target), Gio.SubprocessFlags.NONE).wait_check_async(null));

export function open(url: string) {
  if (!(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:"))) return;
  const launch = existsSync("/.flatpak-info") ? new Gtk.UriLauncher({ uri: url }).launch(null, null) : spawn(url);
  launch.catch((error: GLib.Error) => console.warn(`Unable to open link: ${error.message}`));
}

export function openFile(path: string, window: Gtk.Window | null, finished: (result: Result<null>) => void) {
  const launch = distrobox() ? spawn(path) : new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) }).launch(window, null);
  launch.then(
    () => finished({ ok: true, value: null }),
    (error: GLib.Error) => finished({ ok: false, error: error.message }),
  );
}

export function command(target: string) {
  if (!distrobox()) return ["xdg-open", target];
  const session = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"];
  return ["distrobox-host-exec", "env", ...session.flatMap((key) => (process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`])), "xdg-open", target];
}
