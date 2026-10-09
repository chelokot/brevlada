import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio?version=2.0";
import { MailWorker } from "../backend/worker";
import { Avatars } from "../components/avatars";
import { Expansion } from "../components/expansion";
import { createShell } from "../components/shell";
import { message } from "../models";
import { select } from "./actions";
import { nextComposerRequest } from "./drafts";
import { event } from "./events";
import { createState } from "./index";
import { account, present, useWindows } from "./testing";

useWindows();

test("reopened windows reject previous window results", () => {
  const app = new Adw.Application({ applicationId: "io.github.ExposedCat.Brevlada.LifecycleDiagnostics", flags: Gio.ApplicationFlags.NON_UNIQUE });
  app.register(null);
  const [worker] = MailWorker.recording();
  const open = (email: string) => {
    const state = createState(createShell(app), worker, new Expansion(), new Avatars(() => {}));
    select(state, account(email), "INBOX");
    return state;
  };
  const previous = open("previous@example.com");
  const { generation, selection } = previous;
  const composer = nextComposerRequest(previous);
  present(app.get_windows()[0]).destroy();
  previous.searchWorker.stop();
  const reopened = open("current@example.com");
  expect(reopened.selection).not.toBe(selection);
  expect(nextComposerRequest(reopened)).not.toBe(composer);
  event(reopened, { type: "Messages", generation, messages: [message({ uid: 7, subject: "Previous window" })], cached: false });
  expect(reopened.messages).toHaveLength(0);
  expect(reopened.loading).toBe(true);
  reopened.searchWorker.stop();
});
