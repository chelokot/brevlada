import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSortPreferences } from "./sorting";

test("missing sort preferences default to unread first", () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-sort-"));
  const path = join(directory, "sorting.json");
  expect(loadSortPreferences(path)).toEqual({ sendersUnreadFirst: true, messagesUnreadFirst: true });
  writeFileSync(path, '{"senders_unread_first":false}');
  expect(loadSortPreferences(path)).toEqual({ sendersUnreadFirst: false, messagesUnreadFirst: true });
  rmSync(directory, { recursive: true });
});
