import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save } from "./settings";

test("missing keys default off and both states persist with snake_case keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brevlada-settings-"));
  const path = join(directory, "nested", "settings.json");
  expect(await load(path)).toEqual({ trustAllSenders: false, backgroundService: false });
  await Bun.write(path, '{"trust_all_senders":true}');
  expect(await load(path)).toEqual({ trustAllSenders: true, backgroundService: false });
  for (const trustAllSenders of [true, false]) {
    await save({ trustAllSenders, backgroundService: true }, path);
    expect(await load(path)).toEqual({ trustAllSenders, backgroundService: true });
  }
  expect(await Bun.file(path).text()).toBe('{"trust_all_senders":false,"background_service":true}');
  await Bun.write(path, '{"trust_all_senders":null}');
  await expect(load(path)).rejects.toThrow();
  await rm(directory, { recursive: true });
});
