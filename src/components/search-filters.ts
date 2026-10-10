import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";
import type { Account } from "../models";
import { dates, type Filters, filters as defaults, SOURCE_LABELS } from "../models/search";
import { clear, errorLabel } from "./index";

export type Change = "Accounts" | "Criteria";

export class SearchFilters {
  readonly widget = Gtk.Box.new(Gtk.Orientation.VERTICAL, 0);
  private readonly accountsButton: Gtk.MenuButton;
  private readonly accountsBox: Gtk.Box;
  private readonly useCurrent = Gtk.Button.new_with_label("Use current account");
  private readonly allAccounts = Gtk.Button.new_with_label("Select all accounts");
  private accounts: string[] = [];
  private current: string | null = null;
  private selected: Set<string> | null = null;
  private readonly foldersButton: Gtk.MenuButton;
  private currentFolder: string | null = null;
  private pinnedFolder: string | null = null;
  private readonly useCurrentFolder = Gtk.CheckButton.new_with_label("Current Folder");
  private readonly allFolders = Gtk.CheckButton.new_with_label("All Folders");
  private readonly sourcesButton: Gtk.MenuButton;
  private readonly sources: Gtk.CheckButton[];
  private readonly datesButton: Gtk.MenuButton;
  private readonly from: Gtk.Entry;
  private readonly to: Gtk.Entry;
  private readonly dateError = errorLabel();
  private updating = false;
  private readonly callbacks: ((change: Change) => void)[] = [];

  constructor() {
    [this.accountsButton, this.accountsBox] = dropdown("Accounts (0)");
    this.accountsButton.set_tooltip_text("Search selected accounts");
    const [foldersButton, foldersBox] = dropdown("All Folders");
    this.foldersButton = foldersButton;
    this.useCurrentFolder.set_group(this.allFolders);
    this.useCurrentFolder.set_sensitive(false);
    this.allFolders.set_active(true);
    foldersBox.append(this.allFolders);
    foldersBox.append(this.useCurrentFolder);
    const [sourcesButton, sourcesBox] = dropdown("All Sources");
    this.sourcesButton = sourcesButton;
    this.sources = SOURCE_LABELS.map((label) => {
      const check = Gtk.CheckButton.new_with_label(label);
      check.set_active(true);
      sourcesBox.append(check);
      return check;
    });
    const allSources = Gtk.Button.new_with_label("Enable all sources");
    sourcesBox.append(allSources);
    const [datesButton, datesBox, datesPopover] = dropdown("Any Date");
    this.datesButton = datesButton;
    datesBox.widthRequest = 352;
    [this.from, this.to] = dateInputs(datesBox, datesPopover);
    datesBox.append(this.dateError);
    const clearDates = Gtk.Button.new_with_label("Clear dates");
    datesBox.append(clearDates);
    this.widget.add_css_class("message-search-filters");
    const top = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 6);
    const bottom = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 6);
    top.append(this.accountsButton);
    top.append(this.foldersButton);
    bottom.append(this.sourcesButton);
    bottom.append(this.datesButton);
    this.widget.append(top);
    this.widget.append(bottom);
    this.allFolders.connect("toggled", () => {
      this.pinnedFolder = null;
      this.changed("Criteria");
    });
    for (const check of this.sources) check.connect("toggled", () => this.changed("Criteria"));
    for (const entry of [this.from, this.to]) entry.connect("changed", () => this.changed("Criteria"));
    allSources.connect("clicked", () => {
      this.updating = true;
      for (const check of this.sources) check.set_active(true);
      this.updating = false;
      this.changed("Criteria");
    });
    clearDates.connect("clicked", () => {
      this.updating = true;
      this.from.set_text("");
      this.to.set_text("");
      this.updating = false;
      this.changed("Criteria");
    });
    this.useCurrent.connect("clicked", () => {
      if (this.current === null) return;
      this.selected = null;
      this.rebuildAccounts();
      this.changed("Accounts");
    });
    this.allAccounts.connect("clicked", () => {
      this.selected = new Set(this.accounts);
      this.rebuildAccounts();
      this.changed("Accounts");
    });
    this.rebuildAccounts();
  }

  connectChanged(callback: (change: Change) => void) {
    this.callbacks.push(callback);
  }

  selectedAccounts() {
    return this.accountsFor(this.current);
  }

  accountsFor(current: string | null) {
    return new Set(this.selected ?? (current === null ? this.accounts : [current]));
  }

  resetScope() {
    this.updating = true;
    this.selected = null;
    this.pinnedFolder = null;
    (this.currentFolder === null ? this.allFolders : this.useCurrentFolder).set_active(true);
    this.rebuildAccounts();
  }

  keepSelection() {
    if (this.selected === null) this.selected = this.selectedAccounts();
    if (this.useCurrentFolder.get_active() && this.pinnedFolder === null) this.pinnedFolder = this.currentFolder;
  }

  folder() {
    return this.allFolders.get_active() ? null : (this.pinnedFolder ?? this.currentFolder);
  }

  setCurrentFolder(folder: string | null, preserveSearch: boolean) {
    this.updating = true;
    this.currentFolder = folder || null;
    if (!preserveSearch) this.pinnedFolder = null;
    const available = this.currentFolder !== null;
    this.useCurrentFolder.set_sensitive(available);
    if (!available) this.allFolders.set_active(true);
    this.updating = false;
    this.updateLabels();
  }

  accountLabel() {
    const selected = this.selectedAccounts();
    if (selected.size <= 1) return [...selected].join("");
    return selected.size === this.accounts.length ? "All accounts" : `${selected.size} accounts`;
  }

  filters(): Result<Filters> {
    const range = dates(this.from.get_text(), this.to.get_text());
    if (!range.ok) return range;
    const [from, to] = range.value;
    const value = defaults({ from, to });
    this.sources.forEach((check, index) => (value.sources[index] = check.get_active()));
    return { ok: true, value };
  }

  setAccounts(accounts: Account[]) {
    const before = this.selectedAccounts();
    this.accounts = this.accounts.filter((email) => accounts.some((account) => account.email === email));
    for (const { email } of accounts) if (!this.accounts.includes(email)) this.accounts.push(email);
    if (this.selected !== null) this.selected = new Set([...this.selected].filter((email) => this.accounts.includes(email)));
    if (this.current !== null && !this.accounts.includes(this.current)) this.current = null;
    this.rebuildAccounts();
    if (this.selectedAccounts().symmetricDifference(before).size > 0) this.changed("Accounts");
  }

  setCurrent(email: string | null) {
    this.current = email;
    this.rebuildAccounts();
  }

  private rebuildAccounts() {
    this.updating = true;
    clear(this.accountsBox);
    this.accountsBox.append(this.useCurrent);
    const selected = this.selectedAccounts();
    for (const email of this.accounts) {
      const check = Gtk.CheckButton.new_with_label(email);
      check.set_active(selected.has(email));
      this.accountsBox.append(check);
      check.connect("toggled", (check) => {
        if (this.updating) return;
        const selected = this.selectedAccounts();
        if (check.get_active()) selected.add(email);
        else selected.delete(email);
        this.selected = selected;
        this.changed("Accounts");
      });
    }
    this.accountsBox.append(this.allAccounts);
    this.updating = false;
    this.updateLabels();
  }

  private updateLabels() {
    this.foldersButton.set_label(this.allFolders.get_active() ? "All Folders" : "Current Folder");
    this.foldersButton.set_tooltip_text(this.folder() ?? "Search all cached folders");
    const selected = this.selectedAccounts();
    const all = this.accounts.length > 0 && this.accounts.every((account) => selected.has(account));
    const current = this.current !== null && selected.size === 1 && selected.has(this.current);
    this.accountsButton.set_label(current ? "Current Account" : all ? "All accounts" : `Accounts (${selected.size})`);
    this.allAccounts.set_sensitive(this.accounts.length > 0 && !all);
    this.useCurrent.set_sensitive(this.current !== null && !current);
    const count = this.sources.filter((check) => check.get_active()).length;
    this.sourcesButton.set_label(count === this.sources.length ? "All Sources" : `Sources (${count})`);
    const valid = this.filters();
    this.dateError.set_visible(!valid.ok);
    this.dateError.set_label(valid.ok ? "" : valid.error);
    const [from, to] = [this.from.get_text(), this.to.get_text()];
    this.datesButton.set_label(!valid.ok ? "Invalid dates" : !from.trim() && !to.trim() ? "Any Date" : "Date range");
    this.datesButton.set_tooltip_text(`From: ${from || "any"} · To: ${to || "any"}`);
  }

  private changed(change: Change) {
    if (this.updating) return;
    this.updateLabels();
    for (const callback of this.callbacks) callback(change);
  }
}

function dropdown(label: string): [Gtk.MenuButton, Gtk.Box, Gtk.Popover] {
  const content = Gtk.Box.new(Gtk.Orientation.VERTICAL, 8);
  content.set_margin_top(12);
  content.set_margin_bottom(12);
  content.set_margin_start(12);
  content.set_margin_end(12);
  const popover = new Gtk.Popover({ child: content, autohide: true });
  return [new Gtk.MenuButton({ label, popover, hexpand: true }), content, popover];
}

function dateInput(parent: Gtk.Box, label: string): [Gtk.Entry, Gtk.ToggleButton] {
  const row = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 6);
  const title = Gtk.Label.new(label);
  title.set_width_chars(4);
  title.set_xalign(0);
  row.append(title);
  const entry = new Gtk.Entry({ placeholderText: "YYYY-MM-DD", widthChars: 12, hexpand: true });
  entry.set_tooltip_text("Leave empty for any date");
  row.append(entry);
  const pick = new Gtk.ToggleButton({ iconName: "x-office-calendar-symbolic", tooltipText: `Select ${label} date` });
  row.append(pick);
  parent.append(row);
  return [entry, pick];
}

function dateInputs(parent: Gtk.Box, popover: Gtk.Popover): [Gtk.Entry, Gtk.Entry] {
  const [from, fromPick] = dateInput(parent, "From");
  const [to, toPick] = dateInput(parent, "To");
  const reveal = new Gtk.Revealer();
  parent.append(reveal);
  let target: Gtk.Entry | null = null;
  let syncing = false;
  const calendar = () => {
    const shown = reveal.get_child();
    if (shown instanceof Gtk.Calendar) return shown;
    const created = new Gtk.Calendar();
    created.add_css_class("search-calendar");
    created.set_overflow(Gtk.Overflow.HIDDEN);
    created.connect("day-selected", (calendar) => {
      const entry = target;
      if (syncing || entry === null) return;
      const date = calendar.get_date();
      const pad = (value: number, width: number) => String(value).padStart(width, "0");
      entry.set_text(`${pad(date.get_year(), 4)}-${pad(date.get_month(), 2)}-${pad(date.get_day_of_month(), 2)}`);
      entry.grab_focus();
      fromPick.set_active(false);
      toPick.set_active(false);
    });
    reveal.set_child(created);
    return created;
  };
  const pickers: [Gtk.Entry, Gtk.ToggleButton, Gtk.ToggleButton][] = [
    [from, fromPick, toPick],
    [to, toPick, fromPick],
  ];
  for (const [entry, pick, other] of pickers) {
    pick.connect("toggled", (pick) => {
      if (syncing) return;
      syncing = true;
      if (pick.get_active()) {
        other.set_active(false);
        target = entry;
        const range = dates(entry.get_text(), "");
        const date = range.ok && range.value[0] !== null ? GLib.DateTime.new_from_iso8601(`${range.value[0]}T12:00:00Z`, null) : null;
        if (date !== null) calendar().select_day(date);
      } else target = null;
      reveal.set_reveal_child(pick.get_active());
      if (pick.get_active()) calendar().grab_focus();
      syncing = false;
    });
  }
  popover.connect("show", () => void calendar());
  popover.connect("closed", () => {
    fromPick.set_active(false);
    toPick.set_active(false);
  });
  return [from, to];
}
