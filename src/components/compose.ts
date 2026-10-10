import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";
import type { Draft, Message } from "../models";
import { fromMessage, type Saved, type Target, target } from "../models/draft";
import { type Action, forwardHeader, recipients, subject } from "../models/response";
import { COMPOSE_HEIGHT, SMALL_SPACING, SPACING } from "../theme";
import { Autosave } from "./autosave";
import { Attachments } from "./compose-attachments";
import { Size } from "./editor-size";
import { Editor, toolbar } from "./html-editor";
import { button, column, errorLabel, horizontal } from "./index";
import { insert } from "./reply-quote";

interface Reply {
  inReplyTo: string | null;
  references: string[];
  attachmentSource: Target | null;
}

export type Complete = (result: Result<Draft>) => void;

const reply = (): Reply => ({ inReplyTo: null, references: [], attachmentSource: null });

const entry = (name: string) => new Gtk.Entry({ placeholderText: name, tooltipText: name, hexpand: true, widthChars: 8 });

const text = (buffer: Gtk.TextBuffer) => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), true);

export class Compose {
  readonly autosave = new Autosave();
  readonly widget = column("compose-card");
  private readonly sendError = errorLabel();
  private readonly receiver = entry("Receiver");
  private readonly cc = entry("CC");
  private readonly send: Gtk.Button;
  private readonly cancel = button("window-close-symbolic", "Close");
  private readonly subject = entry("Subject");
  private readonly body = new Gtk.TextView({
    wrapMode: Gtk.WrapMode.WORD_CHAR,
    acceptsTab: false,
    topMargin: SPACING,
    bottomMargin: SPACING,
    leftMargin: SPACING,
    rightMargin: SPACING,
    tooltipText: "Body",
  });
  private readonly textMode = Gtk.ToggleButton.new_with_label("Text");
  private readonly htmlMode = Gtk.ToggleButton.new_with_label("HTML");
  private readonly htmlEditor: Editor;
  private readonly attachments = new Attachments();
  private replyTo = reply();
  private cancelAction: (() => void) | null = null;
  private saveOnClose = true;
  private target: Target | null = null;

  constructor(trigger: Gtk.Button) {
    this.widget.add_css_class("message-row-widget");
    this.widget.set_visible(false);
    this.widget.set_vexpand(false);
    this.widget.append(this.sendError);
    const header = horizontal("compose-header", SMALL_SPACING);
    header.append(this.receiver);
    header.append(this.cc);
    const sendContent = horizontal("compose-send-content", SMALL_SPACING);
    sendContent.append(Gtk.Image.new_from_icon_name("paper-plane-symbolic"));
    sendContent.append(Gtk.Label.new("Send"));
    this.send = new Gtk.Button({ child: sendContent, tooltipText: "Send", valign: Gtk.Align.CENTER, sensitive: false });
    this.send.add_css_class("suggested-action");
    this.send.add_css_class("compose-send");
    header.append(this.send);
    header.append(this.cancel);
    this.widget.append(header);
    this.widget.append(this.subject);
    const bodyGroup = new Adw.PreferencesGroup({ cssClasses: ["compose-body"] });
    const modes = horizontal("linked", 0);
    this.htmlMode.set_group(this.textMode);
    this.textMode.set_active(true);
    this.textMode.set_tooltip_text("Plain text");
    this.htmlMode.set_tooltip_text("Formatted text");
    modes.append(this.textMode);
    modes.append(this.htmlMode);
    modes.set_halign(Gtk.Align.START);
    const bodyHeader = horizontal("compose-body-header", SMALL_SPACING);
    bodyHeader.append(modes);
    const size = new Size();
    size.trackText(this.body);
    this.htmlEditor = new Editor(this.body.get_buffer(), this.htmlMode, (height, edited) => {
      if (edited) this.autosave.changed();
      size.measure(1, height, edited);
    });
    bodyHeader.append(toolbar(this.htmlEditor, this.htmlMode));
    this.widget.append(bodyHeader);
    const buffer = this.body.get_buffer();
    const updateSend = () => this.updateSend();
    this.subject.connect("changed", updateSend);
    buffer.connect("changed", updateSend);
    this.receiver.connect("changed", updateSend);
    const bodyScroll = new Gtk.ScrolledWindow({ child: this.body, minContentHeight: COMPOSE_HEIGHT, hscrollbarPolicy: Gtk.PolicyType.NEVER });
    const editors = size.stack;
    editors.add_named(bodyScroll, "text");
    editors.add_named(this.htmlEditor.view, "html");
    editors.set_visible_child_name("text");
    let dirty = true;
    buffer.connect("changed", () => {
      if (!this.htmlMode.get_active()) dirty = true;
    });
    this.htmlMode.connect("toggled", (mode) => {
      if (!mode.get_active()) {
        editors.set_visible_child_name("text");
        this.body.grab_focus();
        return;
      }
      if (dirty) {
        dirty = false;
        this.htmlEditor.setHtml(`<pre>${GLib.markup_escape_text(text(buffer), -1)}</pre>`);
      }
      editors.set_visible_child_name("html");
      this.htmlEditor.focus();
    });
    bodyGroup.add(
      new Adw.PreferencesRow({ child: editors, cssClasses: ["compose-editor"], overflow: Gtk.Overflow.HIDDEN, activatable: false, selectable: false, focusable: false }),
    );
    this.widget.append(bodyGroup);
    this.widget.append(size.handle());
    this.widget.append(this.attachments.toolbar);
    this.widget.append(this.attachments.widget);
    this.attachments.connectLoading((loading) => {
      if (loading) return this.send.set_sensitive(false);
      this.autosave.changed();
      this.updateSend();
    });
    this.widget.append(this.autosave.status);
    this.cancel.connect("clicked", () =>
      this.autosave.defer(this.saveOnClose, () => {
        if (this.cancelAction !== null) return this.cancelAction();
        this.widget.set_visible(false);
        this.receiver.set_text("");
        this.cc.set_text("");
        this.subject.set_text("");
        this.textMode.set_active(true);
        buffer.set_text("", -1);
        this.htmlEditor.setHtml("");
        this.attachments.clear();
        this.replyTo = reply();
        this.sendError.set_visible(false);
        trigger.grab_focus();
      }),
    );
    for (const input of [this.receiver, this.cc, this.subject]) input.connect("changed", () => this.autosave.changed());
    buffer.connect("changed", () => {
      if (!this.htmlMode.get_active()) this.autosave.changed();
    });
    this.htmlMode.connect("toggled", () => this.autosave.changed());
    this.attachments.connectChanged(() => this.autosave.changed());
  }

  discardOnClose() {
    this.saveOnClose = false;
    this.cancel.set_tooltip_text("Delete draft");
  }

  connectCancel(callback: () => void) {
    this.cancelAction = callback;
  }

  loadDraft(draft: Draft) {
    this.attachments.load(draft);
    this.sendError.set_visible(false);
    this.textMode.set_active(true);
    this.receiver.set_text(draft.to);
    this.cc.set_text(draft.cc);
    this.subject.set_text(draft.subject);
    this.body.get_buffer().set_text(draft.text, -1);
    this.replyTo = { inReplyTo: draft.inReplyTo, references: [...draft.references], attachmentSource: draft.attachmentSource };
    if (draft.html !== null) {
      this.htmlMode.set_active(true);
      this.htmlEditor.setHtml(draft.html);
    }
    this.widget.set_visible(true);
    this.autosave.reset();
  }

  setReady(ready: boolean) {
    this.receiver.set_sensitive(ready);
    this.cc.set_sensitive(ready);
    for (let child: Gtk.Widget | null = this.subject; child; child = child.get_next_sibling()) child.set_sensitive(ready);
    if (ready) this.updateSend();
    else this.send.set_sensitive(false);
  }

  finishSend(success: boolean) {
    this.widget.set_sensitive(true);
    if (!success) return;
    this.autosave.reset();
    this.sendError.set_visible(false);
    this.widget.set_visible(false);
    this.receiver.set_text("");
    this.cc.set_text("");
    this.subject.set_text("");
    this.textMode.set_active(true);
    this.body.get_buffer().set_text("", -1);
    this.htmlEditor.setHtml("");
    this.attachments.clear();
    this.replyTo = reply();
  }

  sendFailed(error: string) {
    this.finishSend(false);
    this.sendError.set_text(`Could not send message: ${error}`);
    this.sendError.set_visible(true);
    this.autosave.resume();
  }

  show(receiver: string) {
    if (!this.widget.get_visible()) this.receiver.set_text(receiver);
    this.widget.set_visible(true);
    this.receiver.grab_focus();
  }

  respond(message: Message, account: string, folder: string, action: Action) {
    if (!this.widget.get_visible()) {
      const [to, cc] = recipients(message, account, action);
      this.receiver.set_text(to);
      this.cc.set_text(cc);
      this.subject.set_text(subject(message, action));
      const context = reply();
      if (action === "Forward") {
        const media = message.attachments.length > 0 || message.inlineMedia.length > 0 || message.bodyHtml.includes("cid:");
        if (media) context.attachmentSource = target(folder, message);
        this.attachments.load(fromMessage(message));
      } else {
        context.references = [...message.references];
        if (message.messageId) {
          context.references.push(message.messageId);
          context.inReplyTo = message.messageId;
        }
      }
      this.replyTo = context;
      this.textMode.set_active(true);
      const buffer = this.body.get_buffer();
      buffer.set_text("", -1);
      this.htmlMode.set_active(message.bodyHtml.trim() !== "");
      if (action === "Forward") {
        const header = forwardHeader(message);
        if (this.htmlMode.get_active()) this.htmlEditor.forward(header, message.bodyHtml);
        else {
          buffer.set_text(`\n\n${header}${message.bodyText}`, -1);
          buffer.place_cursor(buffer.get_start_iter());
        }
      } else if (this.htmlMode.get_active()) this.htmlEditor.reply(message.bodyHtml);
      else insert(buffer, message);
    }
    this.widget.set_visible(true);
    if (action === "Forward") this.receiver.grab_focus();
    else if (this.htmlMode.get_active()) this.htmlEditor.focus();
    else this.body.grab_focus();
  }

  draftTarget() {
    return this.target;
  }

  setDraftTarget(draftTarget: Target) {
    this.target = draftTarget;
  }

  draftSaved(saved: Saved) {
    this.setDraftTarget(target(saved.item.folder, saved.item.message));
    this.attachments.resolve(saved.originalParts);
  }

  snapshot(): Promise<Result<Draft>> {
    const { inReplyTo, references, attachmentSource } = this.replyTo;
    const draft: Draft = {
      to: this.receiver.get_text(),
      cc: this.cc.get_text(),
      subject: this.subject.get_text(),
      text: text(this.body.get_buffer()),
      html: null,
      attachments: this.attachments.parts(),
      attachmentsLoaded: this.attachments.loaded(),
      attachmentNames: this.attachments.names(),
      removedAttachments: this.attachments.removed(),
      attachmentSource,
      inReplyTo,
      references: [...references],
    };
    if (!this.htmlMode.get_active()) return Promise.resolve({ ok: true, value: draft });
    return this.htmlEditor.message().then(
      ([html, plain]): Result<Draft> => ({ ok: true, value: { ...draft, html, text: plain } }),
      (error: Error): Result<Draft> => ({ ok: false, error: `Could not read formatted message: ${error.message}` }),
    );
  }

  connectAutosave(callback: () => Complete) {
    this.autosave.connect(async () => {
      if (!this.widget.get_visible() || !this.receiver.get_sensitive()) return this.autosave.complete({ ok: true, value: null });
      const complete = callback();
      while (this.attachments.loading()) await Bun.sleep(50);
      this.autosave.capture();
      complete(await this.snapshot());
    });
  }

  connectSend(callback: () => Complete) {
    this.send.connect("clicked", () => {
      if (!this.widget.get_sensitive() || this.attachments.loading() || this.autosave.paused()) return;
      this.widget.set_sensitive(false);
      this.autosave.defer(false, () => {
        this.widget.set_sensitive(false);
        this.sendError.set_visible(false);
        this.snapshot().then(callback());
      });
    });
  }

  private updateSend() {
    this.send.set_sensitive(this.receiver.get_text().trim() !== "" && this.subject.get_text().trim() !== "" && text(this.body.get_buffer()).trim() !== "");
  }
}
