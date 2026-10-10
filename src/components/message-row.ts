import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import type { Message } from "../models";
import { key, preview } from "../models/senders";
import { ICON_GAP, ROW_GAP, ROW_VERTICAL_GAP, SENDER_AVATAR_SIZE, SPACING } from "../theme";
import type { Avatars } from "./avatars";
import { date, sender, senderName, subject } from "./display";
import { column, horizontal, label } from "./index";
import { thread } from "./preview";

export function messageRow(group: Message[]) {
  const [message] = group;
  if (!message) throw new Error("Thread has a message");
  const unread = group.some((message) => !message.isRead);
  const container = horizontal("message-row-container", ROW_GAP);
  container.add_css_class("message-row");
  container.add_css_class("message-row-with-icon");
  const left = horizontal("message-row-left", ICON_GAP);
  left.set_hexpand(true);
  left.append(Gtk.Image.new_from_icon_name(unread ? "mail-unread-symbolic" : "mail-read-symbolic"));
  const content = column("message-row-content");
  content.set_hexpand(true);
  content.set_spacing(ROW_VERTICAL_GAP);
  const titleRow = horizontal("message-row-sender-container", ROW_GAP);
  if (group.length > 1) titleRow.append(countBadge(group.length, unread));
  const title = label(subject(message), "message-row-sender");
  title.add_css_class("heading");
  if (unread) title.add_css_class("message-row-sender-unread");
  titleRow.append(title);
  content.append(titleRow);
  const description = label(thread(group), "message-row-subject-label");
  description.add_css_class("dim-label");
  if (unread) description.add_css_class("message-row-subject-unread");
  content.append(description);
  left.append(content);
  container.append(left);
  const latest = group.reduce((latest, message) => (message.timestamp >= latest.timestamp ? message : latest));
  container.append(metadata(latest, group.some((message) => message.isFlagged), group.some((message) => message.isSpam)));
  return container;
}

export function senderRow(group: Message[], avatars: Avatars) {
  const unread = group.some((message) => !message.isRead);
  const message = preview(group);
  if (!message) throw new Error("Sender has a message");
  const container = horizontal("message-row-container", SPACING);
  container.add_css_class("message-row");
  const name = senderName(message);
  const avatar = Adw.Avatar.new(SENDER_AVATAR_SIZE, name, true);
  avatars.attach(avatar, key(message));
  container.append(avatar);
  const content = column("message-row-content");
  content.set_hexpand(true);
  content.set_spacing(ROW_VERTICAL_GAP);
  const heading = horizontal("message-row-sender-container", ROW_GAP);
  const matches = group.filter((message) => message.searchMatch).length;
  if (matches > 1) {
    const badge = countBadge(matches, unread);
    badge.set_tooltip_text(`${matches} matching messages`);
    heading.append(badge);
  }
  const title = label(name, "message-row-sender");
  if (unread) title.add_css_class("message-row-sender-unread");
  heading.append(title);
  content.append(heading);
  const description = label(message.subject.trim() ? message.subject : "(No Subject)", "message-row-subject-label");
  description.add_css_class("dim-label");
  if (unread) description.add_css_class("message-row-subject-unread");
  content.append(description);
  container.append(content);
  container.append(metadata(message, group.some((message) => message.isFlagged), false));
  container.set_tooltip_text(sender(message)[1]);
  return container;
}

function countBadge(count: number, unread: boolean) {
  const badge = horizontal("thread-count-container", 0);
  badge.set_valign(Gtk.Align.CENTER);
  const text = label(String(count), "thread-count-badge-label");
  text.add_css_class("heading");
  text.add_css_class("message-row-sender");
  if (unread) text.add_css_class("message-row-sender-unread");
  text.set_halign(Gtk.Align.CENTER);
  text.set_hexpand(false);
  text.set_ellipsize(Pango.EllipsizeMode.NONE);
  badge.append(text);
  return badge;
}

function metadata(message: Message, starred: boolean, spam: boolean) {
  const right = column("message-row-right");
  right.set_spacing(ROW_VERTICAL_GAP);
  const when = label(date(message, false), "message-row-date");
  when.set_halign(Gtk.Align.END);
  when.set_hexpand(false);
  right.append(when);
  const icons = horizontal("message-row-icons", ROW_GAP);
  icons.set_halign(Gtk.Align.END);
  if (spam) {
    const icon = Gtk.Image.new_from_icon_name("mail-mark-junk-symbolic");
    icon.add_css_class("message-row-spam-icon");
    icon.set_tooltip_text("Spam");
    icons.append(icon);
  }
  if (starred) {
    const star = Gtk.Image.new_from_icon_name("starred-symbolic");
    star.add_css_class("message-row-flag-icon");
    star.set_halign(Gtk.Align.END);
    star.set_tooltip_text("Starred");
    icons.append(star);
  }
  right.append(icons);
  return right;
}
