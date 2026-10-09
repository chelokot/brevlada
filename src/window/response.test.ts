import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import type { Compose } from "../components/compose";
import { descendants } from "../components/testing";
import { message } from "../models";
import { card } from "./actions";
import { account, command, inbox, next, present, useWindows } from "./testing";

useWindows();

const button = (widget: Gtk.Widget, tooltip: string) => present(descendants(widget).find((child): child is Gtk.Button => child instanceof Gtk.Button && child.get_tooltip_text() === tooltip));

test("reply all and forward keep independent edits and the original account", async () => {
  const { state, commands } = inbox("ResponseDraft", "me@example.com");
  const incoming = message({
    uid: 42,
    uidValidity: 7,
    messageId: "incoming",
    sender: "sender@example.com",
    replyTo: "support@example.com",
    recipients: "me@example.com, team@example.com",
    cc: "copy@example.com",
    subject: "Topic",
    bodyText: "Original body",
    attachments: ["report.pdf"],
    bodyLoaded: true,
    isRead: true,
  });
  const view = card(state, incoming, true, null, false, false);
  const respond = (action: string): Compose => {
    button(view.widget, action).emit("clicked");
    const { compose } = present(state.openComposers.at(-1));
    expect(compose["subject"].get_text()).toBe(action === "Forward" ? "Fwd: Topic" : "Re: Topic");
    compose["subject"].set_text(`Edited ${action}`);
    return compose;
  };
  const [reply, replyAll, forward, again] = [respond("Reply"), respond("Reply All"), respond("Forward"), respond("Reply All")];
  expect(state.openComposers.length).toBe(4);
  expect([reply, replyAll, forward].map((compose) => compose["subject"].get_text())).toEqual(["Edited Reply", "Edited Reply All", "Edited Forward"]);
  expect([replyAll["receiver"].get_text(), replyAll["cc"].get_text()]).toEqual(["support@example.com, team@example.com", "copy@example.com"]);
  expect(forward["receiver"].get_text()).toBe("");
  forward["receiver"].set_text("forward@example.com");

  state.account = account("another@example.com");
  state.folder = "Other folder";
  state.generation++;
  state.selection++;
  for (const compose of [replyAll, forward]) {
    button(compose.widget, "Send").emit("clicked");
    const { account: sender, draft, target } = await command(commands, "Compose");
    expect([sender.email, target]).toEqual(["me@example.com", null]);
    if (draft.subject === "Edited Reply All") expect(draft).toMatchObject({ to: "support@example.com, team@example.com", cc: "copy@example.com", inReplyTo: "incoming" });
    else expect(draft).toMatchObject({ subject: "Edited Forward", to: "forward@example.com", inReplyTo: null, attachmentSource: { folder: "INBOX", uid: 42 } });
  }
  expect(next(commands)).toBeNull();
  expect([reply["subject"].get_text(), again["subject"].get_text()]).toEqual(["Edited Reply", "Edited Reply All"]);
});
