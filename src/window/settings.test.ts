import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descendants } from "../components/testing";
import { load } from "../models/settings";
import { isSenderTrusted, isTrusted } from "./index";
import { connectSettings } from "./settings";
import { account, present, testState, useWindows, widget } from "./testing";

useWindows();

const preferences = () => present(Gtk.Window.list_toplevels().find((window) => window instanceof Adw.PreferencesWindow));

const switchRow = (root: Gtk.Widget) => descendants(root).find((child) => child instanceof Adw.SwitchRow);

function openPrivacy(window: Adw.PreferencesWindow) {
  const section = widget(
    descendants(present(window.get_visible_page())).find((child) => child instanceof Adw.ActionRow),
    Adw.ActionRow,
  );
  expect(section.get_title()).toBe("Privacy");
  section.emit("activated");
  const row = widget(switchRow(window), Adw.SwitchRow);
  const page = widget(row.get_ancestor(Adw.NavigationPage.$gtype), Adw.NavigationPage);
  expect(page.get_title()).toBe("Privacy");
  expect(widget(page.get_ancestor(Adw.NavigationView.$gtype), Adw.NavigationView).get_visible_page()).toBe(page);
  return row;
}

async function stored(path: string, trusted: boolean) {
  const deadline = performance.now() + 3000;
  while ((await load(path)).trustAllSenders !== trusted && performance.now() < deadline) await Bun.sleep(10);
  expect((await load(path)).trustAllSenders).toBe(trusted);
}

test("settings menu persists global trust and preserves individual choices", async () => {
  const { state, window, settings } = testState("Settings");
  const directory = join(tmpdir(), `brevlada-settings-ui-${crypto.randomUUID()}`);
  const path = join(directory, "settings.json");
  await connectSettings(state, window, settings, path);
  state.account = account("me@example.com");
  state.trustedSenders = new Map([["me@example.com", new Set(["trusted@example.com"])]]);
  expect([isTrusted(state, "unknown@example.com"), isTrusted(state, "trusted@example.com")]).toEqual([false, true]);
  settings.activate(null);
  const opened = widget(preferences(), Adw.PreferencesWindow);
  expect(switchRow(opened)).toBeUndefined();
  const row = openPrivacy(opened);
  expect([row.get_title(), row.get_active()]).toEqual(["Trust all senders", false]);
  row.set_active(true);
  expect(isTrusted(state, "unknown@example.com")).toBe(true);
  await stored(path, true);
  expect(isSenderTrusted(state, "unknown@example.com")).toBe(false);
  expect(opened.pop_subpage()).toBe(true);
  expect(openPrivacy(opened).get_active()).toBe(true);
  settings.activate(null);
  expect(preferences()).toBe(opened);
  opened.destroy();
  settings.activate(null);
  const reopened = widget(preferences(), Adw.PreferencesWindow);
  expect(reopened).not.toBe(opened);
  const again = openPrivacy(reopened);
  expect(again.get_active()).toBe(true);
  again.set_active(false);
  expect([isTrusted(state, "unknown@example.com"), isTrusted(state, "trusted@example.com")]).toEqual([false, true]);
  await stored(path, false);
  rmSync(directory, { recursive: true });
});
