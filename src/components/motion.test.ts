import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { column, pane } from "./index";
import { Sidebar } from "./motion";
import { settle, useDisplay } from "./testing";

useDisplay();

const animating = (sidebar: Sidebar) => sidebar.pane.get_shrink_start_child();

test("sidebar slide preserves widths when interrupted", async () => {
  const settings = Gtk.Settings.get_default();
  if (!settings) throw new Error("GTK has settings");
  const enabled = settings.gtkEnableAnimations;
  settings.gtkEnableAnimations = true;
  const [accounts, senders, messages, viewer] = ["diagnostic", "diagnostic", "diagnostic", "diagnostic"].map(column);
  if (!accounts || !senders || !messages || !viewer) throw new Error("Columns exist");
  const threads = new Sidebar(messages, viewer, 350, true);
  const content = pane(senders, threads.pane, 300);
  const sidebar = new Sidebar(accounts, content, 250, true);
  const window = new Gtk.Window({ defaultWidth: 1400, defaultHeight: 700, child: sidebar.pane });
  window.present();
  await settle(300);
  const initialViewer = viewer.get_width();
  for (let round = 0; round < 3; round++) {
    sidebar.setVisible(false);
    await settle(60);
    expect(sidebar.pane.get_position()).toBeGreaterThan(0);
    expect(sidebar.pane.get_position()).toBeLessThan(250);
    expect([sidebar.width(), senders.get_width(), messages.get_width()]).toEqual([250, 300, 350]);
    sidebar.setVisible(true);
    await settle(260);
    expect([accounts.get_width(), viewer.get_width()]).toEqual([250, initialViewer]);
    sidebar.setVisible(false);
    await settle(260);
    expect(sidebar.pane.get_start_child()?.get_visible()).toBe(false);
    expect(viewer.get_width()).toBeGreaterThanOrEqual(initialViewer + 250);
    sidebar.setVisible(true);
    await settle(260);
    threads.setVisible(false);
    await settle(60);
    expect([threads.width(), senders.get_width()]).toEqual([350, 300]);
    threads.setVisible(true);
    await settle(260);
    expect(messages.get_width()).toBe(350);
  }
  settings.gtkEnableAnimations = false;
  sidebar.setVisible(false);
  expect(animating(sidebar)).toBe(false);
  sidebar.setVisible(true);
  expect(animating(sidebar)).toBe(false);
  expect(sidebar.width()).toBe(250);
  settings.gtkEnableAnimations = enabled;
  window.destroy();
});

test("toggling sidebars preserves widths and gives space to viewer", () => {
  const [accounts, senders, messages, viewer] = ["diagnostic", "diagnostic", "diagnostic", "diagnostic"].map(column);
  if (!accounts || !senders || !messages || !viewer) throw new Error("Columns exist");
  const threads = new Sidebar(messages, viewer, 350, true);
  const content = pane(senders, threads.pane, 300);
  const accountPane = new Sidebar(accounts, content, 250, true);
  const main = accountPane.pane;
  const allocate = (width: number) => main.allocate(width, 900, -1, null);
  allocate(1600);
  const initialViewer = viewer.get_width();
  for (let round = 0; round < 20; round++) {
    accountPane.setVisible(false);
    allocate(1600);
    expect([senders.get_width(), messages.get_width(), accountPane.width()]).toEqual([300, 350, 250]);
    expect(viewer.get_width()).toBeGreaterThanOrEqual(initialViewer + 250);
    accountPane.setVisible(true);
    allocate(1600);
    expect([accounts.get_width(), senders.get_width(), messages.get_width(), viewer.get_width()]).toEqual([250, 300, 350, initialViewer]);
    threads.setVisible(false);
    allocate(1600);
    expect([senders.get_width(), threads.width()]).toEqual([300, 350]);
    threads.setVisible(true);
    allocate(1600);
    expect([messages.get_width(), viewer.get_width()]).toEqual([350, initialViewer]);
  }
  main.set_position(280);
  threads.pane.set_position(370);
  allocate(1600);
  accountPane.setVisible(false);
  threads.setVisible(false);
  allocate(1900);
  accountPane.setVisible(true);
  threads.setVisible(true);
  allocate(1900);
  expect([accounts.get_width(), senders.get_width(), messages.get_width()]).toEqual([280, 300, 370]);
});
