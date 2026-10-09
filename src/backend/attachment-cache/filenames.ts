import { readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { invalidName, stat, writeIndex, type Index } from "../attachment-cache";

export function available(directory: string, name: string, index: Index) {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const used = new Set(index.values());
  let candidate = name;
  for (let number = 2; candidate === ".attachments.json" || used.has(candidate) || stat(join(directory, candidate)); number++) {
    candidate = `${stem} (${number})${extension}`;
  }
  return candidate;
}

export function migrate(directory: string, index: Index) {
  if (stat(directory)?.isDirectory() !== true) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const identity = entry.name;
    if (!/^[0-9a-f]{64}$/i.test(identity) || !entry.isDirectory()) continue;
    const [file, ...others] = readdirSync(join(directory, identity), { withFileTypes: true });
    if (!file || others.length || !file.isFile()) continue;
    let name = index.get(identity);
    if (name === undefined) {
      name = available(directory, file.name, index);
      index.set(identity, name);
      writeIndex(directory, index);
    }
    if (invalidName(name)) throw new Error("Invalid saved attachment filename");
    if (!stat(join(directory, name))) {
      renameSync(join(directory, identity, file.name), join(directory, name));
      rmdirSync(join(directory, identity));
    }
  }
}
