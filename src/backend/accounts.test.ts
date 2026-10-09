import { expect, test } from "bun:test";
import GLib from "gi://GLib?version=2.0";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoaConfig } from "../../tests/e2e/goa";
import { discover, password, smtpPassword } from "./accounts";

async function firstLine(stream: ReadableStream<Uint8Array>) {
  let text = "";
  for await (const chunk of stream) {
    text += new TextDecoder().decode(chunk);
    if (text.includes("\n")) break;
  }
  return text.trim();
}

test("discovers Online Accounts mail settings and passwords over D-Bus", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-goa-"));
  const bus = Bun.spawn(["dbus-daemon", "--session", "--nofork", "--nopidfile", `--address=unix:path=${directory}/bus`, "--print-address=1"], { stdout: "pipe" });
  const address = await firstLine(bus.stdout);
  const config: GoaConfig = {
    notifications: `${directory}/notifications.jsonl`,
    accounts: [
      {
        id: "zed",
        identity: "Zed",
        password: "zed-secret",
        mail: { EmailAddress: "zed@example.com", ImapHost: "imap.example.com", ImapUserName: "", ImapUseSsl: true, ImapUseTls: false, SmtpSupported: true, SmtpHost: "[::1]:2525", SmtpUserName: "smtp-zed", SmtpUseSsl: false, SmtpUseTls: true, SmtpUseAuth: true, SmtpAuthLogin: false, SmtpAuthPlain: true, SmtpAuthXoauth2: false },
      },
      { id: "alice", identity: "Alice", password: "alice-secret", mail: { EmailAddress: "alice@example.com", ImapHost: "imap.example.com:1993", ImapUserName: "alice", ImapUseSsl: false, ImapUseTls: true, SmtpSupported: false } },
    ],
  };
  await Bun.write(`${directory}/goa.json`, JSON.stringify(config));
  const goa = Bun.spawn(["bun", "tests/e2e/goa.ts", `${directory}/goa.json`], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdout: "pipe" });
  expect(await firstLine(goa.stdout)).toBe("ready");
  GLib.setenv("DBUS_SESSION_BUS_ADDRESS", address, true);
  const accounts = discover();
  expect(accounts).toEqual([
    { path: "/org/gnome/OnlineAccounts/Accounts/alice", email: "alice@example.com", name: "Alice", host: "imap.example.com:1993", username: "alice", port: 143, ssl: false, tls: true, oauth2: false, smtp: null },
    {
      path: "/org/gnome/OnlineAccounts/Accounts/zed",
      email: "zed@example.com",
      name: "Zed",
      host: "imap.example.com",
      username: "zed@example.com",
      port: 993,
      ssl: true,
      tls: false,
      oauth2: false,
      smtp: { host: "::1", port: 2525, username: "smtp-zed", ssl: false, tls: true, auth: true, login: false, plain: true, xoauth2: false },
    },
  ]);
  const [alice, zed] = accounts;
  expect([alice && password(alice), zed && smtpPassword(zed)]).toEqual(["alice-secret", "zed-secret"]);
  goa.kill();
  bus.kill();
  await Promise.all([goa.exited, bus.exited]);
  rmSync(directory, { recursive: true });
});
