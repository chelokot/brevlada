import { expect, test } from "bun:test";
import type { Account } from "../models";
import { Connections } from "./connections";
import { parse } from "./parser";
import { Storage } from "./storage";
import { execute } from "./unsubscribe";

test("leaves get and mailto links for the desktop handler and rejects replaced messages", async () => {
  const account: Account = { path: "", email: "a", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: false, smtp: null };
  const storage = Storage.open(":memory:");
  for (const url of ["https://example.org/preferences", "mailto:leave@example.org"]) {
    const message = parse(2, new TextEncoder().encode(`Message-ID: <same>\r\nList-Unsubscribe: <${url}>\r\n\r\n`), false, false);
    storage.store("a", "INBOX", message);
    expect(await execute(account, "INBOX", 2, "same", storage, new Connections())).toEqual({ kind: "Open", url });
    storage.store("a", "INBOX", { ...message, messageId: "different" });
    await expect(execute(account, "INBOX", 2, "same", storage, new Connections())).rejects.toThrow("The mailbox changed. Reload the folder.");
  }
  await expect(execute(account, "INBOX", 3, "same", storage, new Connections())).rejects.toThrow("Message is no longer cached");
});
