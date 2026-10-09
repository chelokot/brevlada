import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type WebKit from "gi://WebKit?version=6.0";
import type { Account, Message } from "../models";
import { isReply } from "../models/calendar";
import type { Action } from "../models/response";
import { key } from "../models/senders";
import { AVATAR_SIZE, ROW_GAP, SMALL_SPACING, SPACING } from "../theme";
import { view as attachmentsView } from "./attachments";
import type { Avatars } from "./avatars";
import { view as bodyView, enableMedia, error as bodyError, loading as bodyLoading } from "./body";
import { date, sender, senderName } from "./display";
import { hasRemoteMedia } from "./html";
import { button, column, horizontal } from "./index";

type Signals = [adjustment: Gtk.Adjustment, handler: number][];

const disconnectOnDrop = new FinalizationRegistry<Signals>((signals) => {
  for (const [adjustment, handler] of signals) adjustment.disconnect(handler);
});

interface Content {
  message: Message;
  readonly body: Gtk.Revealer;
  webview: WebKit.WebView | null;
  expanded: boolean;
  rendered: boolean;
  media: boolean;
  hasMedia: boolean;
  trusted: boolean;
  readonly hideQuotes: boolean;
  readonly threaded: boolean;
  readonly attachmentAccount: Account | null;
  readonly attachmentFolder: string;
  readonly star: Gtk.Image;
  readonly spam: Gtk.Image;
  readonly statusIcons: Gtk.Box;
  readonly mediaButton: Gtk.Button;
  readonly unsubscribeButton: Gtk.Button;
  readonly onMedia: () => void;
  readonly open: () => void;
  readonly respond: (message: Message, action: Action) => void;
  readonly unsubscribe: (message: Message) => void;
  readonly responsePending: Action[];
  readonly signals: Signals;
}

const updateMediaButton = (content: Content) => content.mediaButton.set_visible(!content.trusted && !content.media && content.hasMedia);

function downloadMedia(content: Content) {
  if (content.media) return;
  content.media = true;
  content.mediaButton.set_visible(false);
  content.onMedia();
  if (content.message.bodyHtml.includes("cid:")) {
    if (!content.message.inlineMediaLoaded) return;
    content.rendered = false;
    content.webview = null;
    show(content);
  } else if (content.webview) enableMedia(content.webview);
}

function show(content: Content) {
  const { body, message } = content;
  if (!body.get_mapped()) return;
  const scroll = body.get_ancestor(Gtk.ScrolledWindow.$gtype);
  if (scroll instanceof Gtk.ScrolledWindow) {
    const [ok, bounds] = body.compute_bounds(scroll);
    if (!ok || bounds.get_y() > scroll.get_height() || bounds.get_y() + bounds.get_height() < 0) return;
  }
  if (content.expanded && message.isSpam && !message.bodyLoaded) {
    if (content.rendered) return;
    content.rendered = true;
    const notice = new Gtk.Label({
      label: "Marked as spam. Use “Not spam” to restore this message.",
      wrap: true,
      xalign: 0,
      marginTop: SPACING,
      marginBottom: SPACING,
      cssClasses: ["dim-label"],
    });
    return body.set_child(notice);
  }
  if (!content.expanded || !message.bodyLoaded || content.rendered) return;
  content.rendered = true;
  if (isReply(message)) {
    body.set_child(attachmentsView(message, content.attachmentAccount, content.attachmentFolder));
    content.webview = null;
    return;
  }
  if (content.trusted) {
    content.media = true;
    content.mediaButton.set_visible(false);
    content.onMedia();
  }
  const [html, view] = bodyView(message, content.media, content.hideQuotes);
  const contentBox = column("message-content");
  contentBox.append(html);
  contentBox.append(attachmentsView(message, content.attachmentAccount, content.attachmentFolder));
  body.set_child(contentBox);
  content.webview = view;
}

export class Card {
  constructor(
    readonly widget: Gtk.Box,
    readonly content: Content,
  ) {}

  finishUnsubscribe(done: boolean) {
    this.content.unsubscribeButton.set_label(done ? "Unsubscribed" : "Unsubscribe");
    this.content.unsubscribeButton.set_sensitive(!done);
  }

  setTrusted(trusted: boolean) {
    this.content.trusted = trusted;
    if (trusted && this.content.rendered) downloadMedia(this.content);
    updateMediaButton(this.content);
  }

  isResponsePending() {
    return this.content.responsePending.length > 0;
  }

  isExpanded() {
    return this.content.expanded;
  }

  layoutMatches(message: Message, threaded: boolean, hideQuotes: boolean) {
    const current = this.content.message;
    return (
      current.uid === message.uid &&
      current.messageId === message.messageId &&
      current.isDraft === message.isDraft &&
      this.content.threaded === threaded &&
      this.content.hideQuotes === hideQuotes
    );
  }

  update(message: Message) {
    const content = this.content;
    const old = content.message;
    const changed =
      old.bodyLoaded &&
      (old.bodyHtml !== message.bodyHtml ||
        old.bodyText !== message.bodyText ||
        isReply(old) !== isReply(message) ||
        !Bun.deepEquals(old.attachments, message.attachments) ||
        !Bun.deepEquals(old.attachmentDetails, message.attachmentDetails));
    const stateChanged = old.bodyLoaded !== message.bodyLoaded || (!old.bodyLoaded && old.isSpam !== message.isSpam);
    const inlineChanged = old.inlineMediaLoaded !== message.inlineMediaLoaded;
    content.message = { ...message };
    content.star.set_visible(message.isFlagged);
    content.spam.set_visible(message.isSpam);
    content.statusIcons.set_visible(message.isFlagged || message.isSpam);
    content.hasMedia = !isReply(message) && hasRemoteMedia(message);
    updateMediaButton(content);
    content.unsubscribeButton.set_visible(message.unsubscribe !== null);
    if (changed || stateChanged || (inlineChanged && content.media && message.bodyHtml.includes("cid:"))) {
      content.rendered = false;
      content.webview = null;
    }
    show(content);
    if (!message.bodyLoaded) return;
    for (const action of content.responsePending.splice(0)) content.respond(message, action);
  }

  error(error: string) {
    if (this.content.message.bodyLoaded) return;
    this.content.webview = null;
    this.content.body.set_child(bodyError(error, this.content.open));
  }

  loading() {
    if (this.content.message.bodyLoaded) return;
    this.content.webview = null;
    this.content.body.set_child(bodyLoading());
  }
}

const RESPONSES = [
  ["mail-reply-sender-symbolic", "Reply", "Reply"],
  ["mail-reply-all-symbolic", "Reply All", "ReplyAll"],
  ["mail-forward-symbolic", "Forward", "Forward"],
] as const;

export function card(
  message: Message,
  expanded: boolean,
  threaded: boolean,
  sent: boolean,
  hideQuotes: boolean,
  avatars: Avatars,
  mediaDownloaded: boolean,
  trusted: boolean,
  attachmentAccount: Account | null,
  attachmentFolder: string,
  open: () => void,
  respond: (message: Message, action: Action) => void,
  onMedia: () => void,
  unsubscribe: (message: Message) => void,
) {
  const widget = column("message-row-widget");
  widget.set_vexpand(false);
  widget.set_valign(Gtk.Align.START);
  const header = horizontal("message-header", SMALL_SPACING);
  const body = new Gtk.Revealer({
    vexpand: false,
    revealChild: expanded || !threaded,
    transitionType: Gtk.RevealerTransitionType.SLIDE_DOWN,
    transitionDuration: 160,
  });
  body.set_child(bodyLoading());
  const mediaButton = button("image-x-generic-symbolic", "Download media");
  const unsubscribeButton = Gtk.Button.new_with_label("Unsubscribe");
  unsubscribeButton.add_css_class("flat");
  unsubscribeButton.set_valign(Gtk.Align.CENTER);
  unsubscribeButton.set_visible(message.unsubscribe !== null);
  mediaButton.set_valign(Gtk.Align.CENTER);
  const hasMedia = !isReply(message) && hasRemoteMedia(message);
  mediaButton.set_visible(!mediaDownloaded && !trusted && hasMedia);
  const star = Gtk.Image.new_from_icon_name("starred-symbolic");
  star.add_css_class("message-row-flag-icon");
  star.set_halign(Gtk.Align.END);
  star.set_visible(message.isFlagged);
  star.set_tooltip_text("Starred");
  const spam = Gtk.Image.new_from_icon_name("mail-mark-junk-symbolic");
  spam.add_css_class("message-row-spam-icon");
  spam.set_visible(message.isSpam);
  spam.set_tooltip_text("Spam");
  const icons = horizontal("message-row-icons", ROW_GAP);
  icons.set_halign(Gtk.Align.END);
  icons.set_visible(message.isFlagged || message.isSpam);
  icons.append(spam);
  icons.append(star);
  const content: Content = {
    message: { ...message },
    body,
    webview: null,
    expanded: expanded || !threaded,
    rendered: false,
    media: mediaDownloaded,
    hasMedia,
    trusted,
    hideQuotes,
    threaded,
    attachmentAccount,
    attachmentFolder,
    star,
    spam,
    statusIcons: icons,
    mediaButton,
    unsubscribeButton,
    onMedia,
    open,
    respond,
    unsubscribe,
    responsePending: [],
    signals: [],
  };
  disconnectOnDrop.register(content, content.signals);
  const contents = new WeakRef(content);
  const showContent = () => {
    const content = contents.deref();
    if (content) show(content);
  };
  body.connect("map", (body) => {
    const content = contents.deref();
    if (!content) return;
    const scroll = body.get_ancestor(Gtk.ScrolledWindow.$gtype);
    if (content.signals.length === 0 && scroll instanceof Gtk.ScrolledWindow) {
      const adjustment = scroll.get_vadjustment();
      content.signals.push([adjustment, adjustment.connect("changed", showContent)], [adjustment, adjustment.connect("value-changed", showContent)]);
    }
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      showContent();
      return GLib.SOURCE_REMOVE;
    });
  });
  if (threaded) {
    const expand = button(content.expanded ? "pan-down-symbolic" : "pan-end-symbolic", "Expand message");
    expand.add_css_class("message-expand");
    expand.set_valign(Gtk.Align.CENTER);
    expand.connect("clicked", (button) => {
      const content = contents.deref();
      if (!content) return;
      content.expanded = !content.expanded;
      content.body.set_reveal_child(content.expanded);
      button.set_icon_name(content.expanded ? "pan-down-symbolic" : "pan-end-symbolic");
      if (!content.expanded) return;
      show(content);
      content.open();
    });
    header.append(expand);
  }
  const [name, email] = sender(message);
  const row = new Adw.ActionRow({ title: sent || message.isDraft ? `To: ${message.recipients}` : senderName(message), useMarkup: false, hexpand: true });
  if (message.isDraft) row.set_subtitle("Draft");
  else if (sent) row.set_subtitle("Sent");
  else if (name && email) row.set_subtitle(email);
  for (const [icon, title, action] of RESPONSES) {
    const response = button(icon, title);
    response.set_valign(Gtk.Align.CENTER);
    response.connect("clicked", () => {
      const content = contents.deref();
      if (!content) return;
      if (content.message.bodyLoaded) return content.respond(content.message, action);
      content.responsePending.push(action);
      content.open();
    });
    row.add_suffix(response);
  }
  mediaButton.connect("clicked", () => {
    const content = contents.deref();
    if (content) downloadMedia(content);
  });
  row.add_suffix(mediaButton);
  const metadata = horizontal("message-row-right", ROW_GAP);
  metadata.set_valign(Gtk.Align.CENTER);
  metadata.append(new Gtk.Label({ label: date(message, true), halign: Gtk.Align.END, cssClasses: ["message-row-date"] }));
  metadata.append(icons);
  row.add_suffix(metadata);
  unsubscribeButton.connect("clicked", (button) => {
    const content = contents.deref();
    if (!content || content.message.unsubscribe === null) return;
    button.set_sensitive(false);
    button.set_label("Unsubscribing…");
    content.unsubscribe(content.message);
  });
  row.add_suffix(unsubscribeButton);
  const avatar = Adw.Avatar.new(AVATAR_SIZE, senderName(message), true);
  avatar.add_css_class("message-avatar");
  avatars.attach(avatar, key(message));
  row.add_prefix(avatar);
  header.append(row);
  widget.append(header);
  widget.append(body);
  show(content);
  return new Card(widget, content);
}
