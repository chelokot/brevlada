import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { INDENT } from "../theme";
import { Expansion } from "./expansion";
import { populate } from "./folders";
import { clear, column, label } from "./index";
import { folderIcon, Selection, Unread } from "./sidebar";
import { buttons, labels, useDisplay } from "./testing";

useDisplay();

const unreadClass = (unread: Unread, folder: string) => unread.labels.get(folder)?.has_css_class("unread");

test("unread highlights follow nested folders and clear after reading", () => {
  const unread = new Unread();
  const account = label("Account", "account-text");
  unread.bind("", account);
  const container = column("account-folders");
  const refill = () => {
    clear(container);
    populate(container, ["Work/Updates", "Personal"], unread, new Expansion(), new Selection(), () => {});
  };
  refill();
  expect(account.has_css_class("unread")).toBe(false);
  unread.update([["Work/Updates", true]]);
  expect(account.has_css_class("unread")).toBe(true);
  expect(["Work", "Work/Updates", "Personal"].map((folder) => unreadClass(unread, folder))).toEqual([true, true, false]);
  refill();
  expect(unreadClass(unread, "Work/Updates")).toBe(true);
  unread.update([["Work/Updates", false]]);
  expect([...unread.labels.values()].some((label) => label.has_css_class("unread"))).toBe(false);
  unread.update([["INBOX", true]]);
  expect(account.has_css_class("unread")).toBe(true);
  expect(unreadClass(unread, "Work")).toBe(false);
  unread.replace([]);
  expect(account.has_css_class("unread")).toBe(false);
});

test("folders nest in byte order without the inbox, expanding parents and selecting leaves", () => {
  const container = column("account-folders");
  const selected: string[] = [];
  populate(container, ["inbox", "Zeta", "Archive/2024", "Archive", "Sent Items"], new Unread(), new Expansion(), new Selection(), (folder) => selected.push(folder));
  const rows = buttons(container);
  expect(rows.map((row) => labels(row)[0])).toEqual(["Archive", "2024", "Sent Items", "Zeta"]);
  const [archive, year, sent] = rows;
  if (!archive || !year || !sent) throw new Error("Folders are listed");
  expect([archive.get_margin_start(), year.get_margin_start()]).toEqual([INDENT, 2 * INDENT]);
  const children = archive.get_next_sibling();
  expect(children?.get_visible()).toBe(false);
  archive.emit("clicked");
  expect(children?.get_visible()).toBe(true);
  sent.emit("clicked");
  expect(selected).toEqual(["Sent Items"]);
  expect(sent.get_state_flags() & Gtk.StateFlags.CHECKED).toBeTruthy();
  expect([folderIcon("Sent Items"), folderIcon("[Gmail]/All Mail"), folderIcon("Junk"), folderIcon("Work")]).toEqual([
    "mail-send-symbolic",
    "mail-unread-symbolic",
    "mail-mark-junk-symbolic",
    "folder-symbolic",
  ]);
});
