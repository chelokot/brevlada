import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./pane-state";

test("restores current and legacy layouts", () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-layout-"));
  const path = join(directory, "layout.json");
  const restore = (saved: unknown) => {
    writeFileSync(path, JSON.stringify(saved));
    return load(path);
  };
  expect(load(join(directory, "missing.json"))).toEqual({ sidebar_width: 300, sender_width: 400, thread_width: 400, maximized: false });
  expect(restore({ sidebar_width: 280, sender_width: 420, thread_width: 380, maximized: true })).toEqual({ sidebar_width: 280, sender_width: 420, thread_width: 380, maximized: true });
  expect(restore({ sidebar_width: 280, sender_width: 420, thread_width: 380 })).toEqual({ sidebar_width: 280, sender_width: 420, thread_width: 380, maximized: false });
  expect(restore({ sidebar_fraction: 0.2, messages_fraction: 0.25, threads_fraction: 0.5, maximized: true })).toEqual({ sidebar_width: 280, sender_width: 280, thread_width: 420, maximized: true });
  expect(restore({ sidebar_fraction: 0.2, messages_fraction: 0.25, sidebar_collapsed: true })).toEqual({ sidebar_width: 280, sender_width: 350, thread_width: 400, maximized: false });
  expect(restore({ sidebar: 310, messages: 410 })).toEqual({ sidebar_width: 310, sender_width: 410, thread_width: 400, maximized: false });
  expect(() => restore({ sidebar_width: 280.5, sender_width: 420, thread_width: 380 })).toThrow("data did not match any variant of untagged enum SavedState");
  rmSync(directory, { recursive: true });
});
