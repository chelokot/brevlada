import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import GObject from "gi://GObject?version=2.0";
import { startLoop, stopLoop } from "./loop";

beforeAll(startLoop);
afterAll(stopLoop);

describe("variants", () => {
  test.each([
    ["(suu)", ["account", 7, 42]],
    ["a{sv}", { name: new GLib.Variant("s", "x"), on: new GLib.Variant("b", true) }],
    ["as", ["a", "b"]],
    ["(oa{sa{sv}})", ["/p", { iface: { Key: new GLib.Variant("u", 3) } }]],
    ["mi", null],
    ["ay", [1, 2, 255]],
  ])("%s round-trips", (signature, value) => {
    const variant = new GLib.Variant(signature, value);
    expect(variant.get_type_string()).toBe(signature);
    expect(new GLib.Variant(signature, variant.deepUnpack()).equal(variant)).toBe(true);
  });

  test("recursive unpack resolves nested variants", () => {
    const variant = new GLib.Variant("a{sv}", { list: new GLib.Variant("as", ["x"]), count: new GLib.Variant("t", 9) });
    expect(variant.recursiveUnpack()).toEqual({ list: ["x"], count: 9 });
  });
});

describe("objects", () => {
  test("construct properties, accessors and methods agree", () => {
    const action = new Gio.SimpleAction({ name: "open", enabled: false });
    expect([action.name, action.get_name(), action.enabled]).toEqual(["open", "open", false]);
    action.enabled = true;
    expect(action.get_enabled()).toBe(true);
  });

  test("signals receive converted arguments and can be disconnected", () => {
    const store = new Gio.ListStore({ itemType: GObject.Object.$gtype });
    const changes: number[][] = [];
    const id = store.connect("items-changed", (self, position, removed, added) => {
      expect(self).toBe(store);
      changes.push([position, removed, added]);
    });
    store.append(new GObject.Object());
    store.disconnect(id);
    store.append(new GObject.Object());
    expect(changes).toEqual([[0, 0, 1]]);
  });

  test("plain values convert to GValues", () => {
    const action = new Gio.SimpleAction({ name: "value" });
    action.set_property("enabled", false);
    expect(action.enabled).toBe(false);
  });

  test("objects returned from native code can connect signals", () => {
    const action = Gio.SimpleAction.new("returned", null);
    let activations = 0;
    action.connect("activate", () => activations++);
    action.activate(null);
    expect(activations).toBe(1);
  });

  test("private GTypes expose their interfaces", () => {
    const file = Gio.File.new_for_path("/etc/hostname");
    expect(file.get_basename()).toBe("hostname");
  });

  test("errors are thrown as GLib.Error with domain matching", () => {
    expect.assertions(2);
    try {
      Gio.File.new_for_path("/nonexistent").load_contents(null);
    } catch (error) {
      expect(error).toBeInstanceOf(GLib.Error);
      expect((error as GLib.Error).matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)).toBe(true);
    }
  });

  test("wrappers held by native containers keep their handlers across garbage collection", () => {
    const store = new Gio.ListStore({ itemType: Gio.SimpleAction.$gtype });
    let activations = 0;
    (() => {
      const action = new Gio.SimpleAction({ name: "kept" });
      action.connect("activate", () => activations++);
      store.append(action);
    })();
    Bun.gc(true);
    (store.get_item(0) as Gio.SimpleAction).activate(null);
    expect(activations).toBe(1);
  });

  test("objects passed inside arrays keep their wrapper identity", () => {
    const store = new Gio.ListStore({ itemType: GObject.Object.$gtype });
    const rows = new WeakMap<GObject.Object, string>();
    (() => {
      const item = new GObject.Object();
      rows.set(item, "row");
      store.splice(0, 0, [item]);
    })();
    Bun.gc(true);
    expect(rows.get(store.get_item(0)!)).toBe("row");
  });

  test("unreferenced wrappers are collected", async () => {
    const finalized = new FinalizationRegistry<number>(() => collected++);
    let collected = 0;
    for (let index = 0; index < 100; index++) finalized.register(new GObject.Object(), index);
    for (let attempt = 0; attempt < 20 && collected < 99; attempt++) {
      Bun.gc(true);
      await Bun.sleep(10);
    }
    expect(collected).toBeGreaterThanOrEqual(99);
  });
});

describe("callbacks and the main loop", () => {
  test("async methods resolve as promises", async () => {
    const [contents, etag] = await Gio.File.new_for_path("/etc/hostname").load_contents_async(null);
    expect(etag).toContain(":");
    expect(contents.length).toBeGreaterThan(0);
  });

  test("GLib timeouts and Bun timers interleave", async () => {
    const order: string[] = [];
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      order.push("glib");
      return GLib.SOURCE_REMOVE;
    });
    setTimeout(() => order.push("bun"), 5);
    await Bun.sleep(60);
    expect(order).toEqual(["bun", "glib"]);
  });

  test("D-Bus objects can be exported and called", async () => {
    const bus = await Gio.bus_get(Gio.BusType.SESSION, null);
    const node = Gio.DBusNodeInfo.new_for_xml(`<node><interface name="test.Echo"><method name="Echo"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>`);
    const id = bus.register_object("/test", node.interfaces[0]!, (...[, , , , , parameters, invocation]: [unknown, string, string, string, string, GLib.Variant, Gio.DBusMethodInvocation]) =>
      invocation.return_value(new GLib.Variant("(s)", [`echo ${parameters.deepUnpack()}`])),
    null, null);
    const reply = await bus.call(bus.get_unique_name(), "/test", "test.Echo", "Echo", new GLib.Variant("(s)", ["hi"]), null, Gio.DBusCallFlags.NONE, 1000, null);
    bus.unregister_object(id);
    expect(reply.deepUnpack()).toEqual(["echo hi"]);
  });
});
