import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";

const SERVICE = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const INTERFACE = "org.freedesktop.portal.Background";
const TIMEOUT = 30_000;

export async function request() {
  const bus = await Gio.bus_get(Gio.BusType.SESSION, null);
  const token = `brevlada_${GLib.uuid_string_random().replaceAll("-", "_")}`;
  const unique = bus.get_unique_name();
  if (!unique) throw new Error("Missing session-bus identity");
  const path = `/org/freedesktop/portal/desktop/request/${unique.replace(/^:+/, "").replaceAll(".", "_")}/${token}`;
  const response = Promise.withResolvers<GLib.Variant>();
  const subscription = bus.signal_subscribe(
    SERVICE,
    "org.freedesktop.portal.Request",
    "Response",
    path,
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => response.resolve(parameters),
  );
  try {
    const options = {
      handle_token: new GLib.Variant("s", token),
      reason: new GLib.Variant("s", "Check for new mail and notify you when Brevlada is closed"),
      autostart: new GLib.Variant("b", false),
    };
    const reply = await bus.call(
      SERVICE,
      PATH,
      INTERFACE,
      "RequestBackground",
      new GLib.Variant("(sa{sv})", ["", options]),
      null,
      Gio.DBusCallFlags.NONE,
      TIMEOUT,
      null,
    );
    if (reply.get_type_string() !== "(o)") throw new Error("Invalid background request");
    if (reply.get_child_value(0).get_string()[0] !== path) throw new Error("Unexpected background request path");
    validateResponse(await response.promise);
  } finally {
    bus.signal_unsubscribe(subscription);
  }
}

export function validateResponse(result: GLib.Variant) {
  if (result.get_type_string() !== "(ua{sv})") throw new Error("Invalid background response");
  const values = result.get_child_value(1);
  const flag = (key: string) => {
    const value = values.lookup_value(key, new GLib.VariantType("b"));
    return value && value.get_boolean();
  };
  if (result.get_child_value(0).get_uint32() !== 0) throw new Error("Background request was cancelled or denied");
  if (flag("autostart") !== false) throw new Error("Login startup was not disabled");
  if (flag("background") !== true) throw new Error("Background access was denied");
}

export async function status() {
  const bus = await Gio.bus_get(Gio.BusType.SESSION, null);
  const properties = await bus.call(
    SERVICE,
    PATH,
    "org.freedesktop.DBus.Properties",
    "Get",
    new GLib.Variant("(ss)", [INTERFACE, "version"]),
    null,
    Gio.DBusCallFlags.NONE,
    TIMEOUT,
    null,
  );
  if (properties.get_type_string() !== "(v)") throw new Error("Invalid background portal version");
  const version = properties.get_child_value(0).get_variant();
  if (version.get_type_string() !== "u" || version.get_uint32() < 2) return;
  const options = { message: new GLib.Variant("s", "Checking for new mail") };
  await bus.call(SERVICE, PATH, INTERFACE, "SetStatus", new GLib.Variant("(a{sv})", [options]), null, Gio.DBusCallFlags.NONE, TIMEOUT, null);
}
