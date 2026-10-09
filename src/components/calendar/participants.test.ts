import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Participant } from "../../models/calendar";
import { CALENDAR_AVATAR_SIZE } from "../../theme";
import { Avatars } from "../avatars";
import { useDisplay } from "../testing";
import { rows } from "./participants";

useDisplay();

test("connects static response rows without expanders", () => {
  const people: Participant[] = [
    { attendee: { email: "alex@example.com", name: "Alex", status: "ACCEPTED" }, respondedAt: new Date(2026, 9, 3, 16, 35).getTime() / 1000, unread: false },
    { attendee: { email: "sam@example.com", name: "Sam", status: "NEEDS-ACTION" }, respondedAt: null, unread: false },
  ];
  const tree = rows(people, new Avatars(() => {}));
  const first = tree.get_first_child();
  const last = tree.get_last_child();
  if (!(first instanceof Gtk.Grid && last instanceof Gtk.Grid)) throw new Error("Participants are grids");
  expect(first.get_child_at(0, 0)?.get_last_child()?.has_css_class("calendar-branch-stem")).toBe(true);
  const header = first.get_child_at(2, 0);
  const avatar = header?.get_first_child();
  expect(avatar instanceof Adw.Avatar && avatar.get_size()).toBe(CALENDAR_AVATAR_SIZE);
  const status = header?.get_last_child();
  expect(status instanceof Gtk.Label && status.get_text()).toBe("Accepted · 3 Oct 2026 16:35");
  expect(last.get_child_at(0, 0)?.get_last_child()?.has_css_class("calendar-branch-top")).toBe(true);
  const awaiting = last.get_child_at(2, 0)?.get_last_child();
  expect(awaiting instanceof Gtk.Label && awaiting.get_text()).toBe("Awaiting response");
});
