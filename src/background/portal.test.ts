import { expect, test } from "bun:test";
import GLib from "gi://GLib?version=2.0";
import { validateResponse } from "./portal";

const response = (code: number, background: boolean, autostart: boolean) =>
  new GLib.Variant("(ua{sv})", [code, { background: new GLib.Variant("b", background), autostart: new GLib.Variant("b", autostart) }]);

test("background permission requires login startup to stay disabled", () => {
  expect(() => validateResponse(response(0, true, false))).not.toThrow();
  expect(() => validateResponse(response(0, false, false))).toThrow("Background access was denied");
  expect(() => validateResponse(response(0, true, true))).toThrow("Login startup was not disabled");
  expect(() => validateResponse(response(1, true, false))).toThrow("Background request was cancelled or denied");
  expect(() => validateResponse(new GLib.Variant("(u)", [0]))).toThrow("Invalid background response");
});
