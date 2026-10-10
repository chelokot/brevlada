import { expect, test } from "bun:test";
import type { Status } from "../models/sync";
import { presentation } from "./sync-status";

test("shows elapsed time since start even when sync has failed", () => {
  const now = 100_000;
  const status: Status = { activity: null, active: 0, queued: 0, failed: 0, lastStarted: null };
  expect(presentation(status, now)[0]).toBe("Last synced: —");
  for (const [seconds, expected] of [
    [0, "just now"],
    [59, "just now"],
    [60, "1m ago"],
    [7200, "2h ago"],
    [86400, "1d ago"],
  ] as const) {
    status.lastStarted = now - seconds;
    expect(presentation(status, now)[0]).toBe(`Last synced: ${expected}`);
  }
  status.failed = 1;
  expect(presentation(status, now)[0]).toBe("Last synced: 1d ago");
  expect(presentation(status, now)[1]).toMatch(/^Last sync started: [A-Z][a-z]{2} \d{2}, \d{4} \d{2}:\d{2}:\d{2}\n1 sync requests failed\. They will retry automatically\.$/);
});

test("describes the running sync with its folder, queue and failures", () => {
  const progress = { accounts: null, folders: null, messages: null };
  const status: Status = { activity: { description: "Fetching headers", folder: "INBOX", progress }, active: 2, queued: 3, failed: 1, lastStarted: null };
  expect(presentation(status, 0)).toEqual(["Syncing", "Fetching headers\nINBOX\n2 active, 3 queued\n1 failed; will retry on the next sync"]);
  status.activity = { description: "Fetching headers", folder: "", progress };
  status.failed = 0;
  expect(presentation(status, 0)).toEqual(["Syncing", "Fetching headers\n2 active, 3 queued"]);
});
