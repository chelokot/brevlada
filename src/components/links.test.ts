import { expect, test } from "bun:test";
import { command } from "./links";

test("forwards graphical session when running in distrobox", () => {
  const argv = command("https://example.com");
  if (process.env["DISTROBOX_ENTER_PATH"] !== undefined) {
    expect(argv[0]).toBe("distrobox-host-exec");
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"]) {
      if (process.env[key] !== undefined) expect(argv).toContain(`${key}=${process.env[key]}`);
    }
  }
  expect(argv.at(-1)).toBe("https://example.com");
});
