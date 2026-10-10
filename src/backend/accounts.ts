import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import type { Account, SmtpSettings } from "../models";

const OAUTH = "org.gnome.OnlineAccounts.OAuth2Based";
type Properties = Record<string, GLib.Variant>;

function call(path: string, iface: string, method: string, args: GLib.Variant | null, signature: string, invalid: string) {
  const reply = Gio.bus_get_sync(Gio.BusType.SESSION, null).call_sync("org.gnome.OnlineAccounts", path, iface, method, args, null, Gio.DBusCallFlags.NONE, 30_000, null);
  if (reply.get_type_string() !== signature) throw new Error(invalid);
  return reply;
}

const string = (properties: Properties, key: string) => {
  const value = properties[key];
  return value && ["s", "o", "g"].includes(value.get_type_string()) ? value.get_string()[0] : "";
};

const boolean = (properties: Properties, key: string) => {
  const value = properties[key];
  return value !== undefined && value.get_type_string() === "b" && value.get_boolean();
};

export function discover(): Account[] {
  const reply = call("/org/gnome/OnlineAccounts", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", null, "(a{oa{sa{sv}}})", "Invalid Online Accounts response");
  const [objects] = reply.deepUnpack<[Record<string, Record<string, Properties>>]>();
  const result: Account[] = [];
  for (const [path, interfaces] of Object.entries(objects)) {
    const account = interfaces["org.gnome.OnlineAccounts.Account"];
    const mail = interfaces["org.gnome.OnlineAccounts.Mail"];
    if (!account || !mail || boolean(account, "MailDisabled")) continue;
    const email = string(mail, "EmailAddress");
    const username = string(mail, "ImapUserName");
    const ssl = boolean(mail, "ImapUseSsl");
    const smtpSsl = boolean(mail, "SmtpUseSsl");
    const port = mail["ImapPort"];
    const smtp: SmtpSettings | null = boolean(mail, "SmtpSupported")
      ? {
          ...smtpEndpoint(string(mail, "SmtpHost"), smtpSsl),
          username: string(mail, "SmtpUserName"),
          ssl: smtpSsl,
          tls: boolean(mail, "SmtpUseTls"),
          auth: boolean(mail, "SmtpUseAuth"),
          login: boolean(mail, "SmtpAuthLogin"),
          plain: boolean(mail, "SmtpAuthPlain"),
          xoauth2: boolean(mail, "SmtpAuthXoauth2"),
        }
      : null;
    result.push({
      path,
      email,
      name: string(account, "PresentationIdentity"),
      host: string(mail, "ImapHost"),
      username: username || email,
      port: port && port.get_type_string() === "u" && port.get_uint32() <= 65535 ? port.get_uint32() : ssl ? 993 : 143,
      ssl,
      tls: boolean(mail, "ImapUseTls"),
      oauth2: OAUTH in interfaces,
      smtp,
    });
  }
  return result.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

function smtpEndpoint(value: string, ssl: boolean): { host: string; port: number } {
  const separator = value.lastIndexOf(":");
  const host = value.slice(0, separator);
  const port = value.slice(separator + 1);
  if (separator >= 0 && /^\+?\d+$/.test(port) && Number(port) <= 65535 && (!host.includes(":") || host.startsWith("["))) {
    return { host: host.replace(/^[[\]]+|[[\]]+$/g, ""), port: Number(port) };
  }
  return { host: value.replace(/^[[\]]+|[[\]]+$/g, ""), port: ssl ? 465 : 587 };
}

export function token(account: Account): string {
  return call(account.path, OAUTH, "GetAccessToken", null, "(si)", "Invalid OAuth2 response").get_child_value(0).get_string()[0];
}

export const password = (account: Account) => passwordFor(account, "imap-password");

export const smtpPassword = (account: Account) => passwordFor(account, "smtp-password");

function passwordFor(account: Account, kind: string): string {
  const reply = call(account.path, "org.gnome.OnlineAccounts.PasswordBased", "GetPassword", new GLib.Variant("(s)", [kind]), "(s)", "Invalid password response");
  return reply.get_child_value(0).get_string()[0];
}
