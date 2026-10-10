import { appendFileSync } from "node:fs";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { startLoop } from "../../src/gi/loop";

export type GoaAccount = { id: string; identity: string; password: string; mail: Record<string, string | boolean> };
export type GoaConfig = { accounts: GoaAccount[]; notifications: string };

const argument = (direction: "in" | "out", type: string) => `<arg type="${type}" direction="${direction}"/>`;
const method = (name: string, inputs: string[], outputs: string[]) =>
  `<method name="${name}">${inputs.map((type) => argument("in", type)).join("")}${outputs.map((type) => argument("out", type)).join("")}</method>`;
const node = Gio.DBusNodeInfo.new_for_xml(`<node>
  <interface name="org.freedesktop.DBus.ObjectManager">${method("GetManagedObjects", [], ["a{oa{sa{sv}}}"])}</interface>
  <interface name="org.gnome.OnlineAccounts.PasswordBased">${method("GetPassword", ["s"], ["s"])}</interface>
  <interface name="org.freedesktop.Notifications">
    ${method("Notify", ["s", "u", "s", "s", "s", "as", "a{sv}", "i"], ["u"])}${method("CloseNotification", ["u"], [])}
    ${method("GetCapabilities", [], ["as"])}${method("GetServerInformation", [], ["s", "s", "s", "s"])}
  </interface>
</node>`);
const [manager, passwords, notifications] = node.interfaces as [Gio.DBusInterfaceInfo, Gio.DBusInterfaceInfo, Gio.DBusInterfaceInfo];

type Handler = (method: string, parameters: unknown[]) => GLib.Variant | null;
const serve = (bus: Gio.DBusConnection, path: string, info: Gio.DBusInterfaceInfo, handler: Handler) =>
  bus.register_object(
    path,
    info,
    (_bus: unknown, _sender: string, _path: string, _interface: string, name: string, parameters: GLib.Variant, invocation: Gio.DBusMethodInvocation) =>
      invocation.return_value(handler(name, parameters.recursiveUnpack() as unknown[])),
    null,
    null,
  );

startLoop();
const config: GoaConfig = await Bun.file(process.argv[2]!).json();
const bus = await Gio.bus_get(Gio.BusType.SESSION, null);
const variant = (value: string | boolean) => new GLib.Variant(typeof value === "boolean" ? "b" : "s", value);
const objects = Object.fromEntries(
  config.accounts.map(({ id, identity, mail }) => [
    `/org/gnome/OnlineAccounts/Accounts/${id}`,
    {
      "org.gnome.OnlineAccounts.Account": {
        PresentationIdentity: variant(identity),
        ProviderType: variant("imap_smtp"),
        ProviderName: variant("IMAP and SMTP"),
      },
      "org.gnome.OnlineAccounts.Mail": Object.fromEntries(Object.entries(mail).map(([key, value]) => [key, variant(value)])),
      "org.gnome.OnlineAccounts.PasswordBased": {},
    },
  ]),
);
serve(bus, "/org/gnome/OnlineAccounts", manager, () => new GLib.Variant("(a{oa{sa{sv}}})", [objects]));
for (const { id, password } of config.accounts) serve(bus, `/org/gnome/OnlineAccounts/Accounts/${id}`, passwords, () => new GLib.Variant("(s)", [password]));
let notified = 0;
serve(bus, "/org/freedesktop/Notifications", notifications, (name, [application, replaces, , summary, body]) => {
  if (name === "GetCapabilities") return new GLib.Variant("(as)", [["body", "actions"]]);
  if (name === "GetServerInformation") return new GLib.Variant("(ssss)", ["brevlada-e2e", "brevlada", "1", "1.2"]);
  if (name === "CloseNotification") return null;
  appendFileSync(config.notifications, `${JSON.stringify({ application, replaces, summary, body })}\n`);
  return new GLib.Variant("(u)", [++notified]);
});
for (const name of ["org.gnome.OnlineAccounts", "org.freedesktop.Notifications"])
  await bus.call(
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
    "RequestName",
    new GLib.Variant("(su)", [name, 4]),
    null,
    Gio.DBusCallFlags.NONE,
    -1,
    null,
  );
console.log("ready");
