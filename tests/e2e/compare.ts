import { $ } from "bun";
import { mkdir, readdir } from "node:fs/promises";

type Image = { width: number; height: number; pixels: Buffer };
export type Difference = { name: string; pixels: number; note: string };
type Timing = { ready: number; total: number };

async function decode(path: string): Promise<Image> {
  const data = Buffer.from(await $`magick ${path} -depth 8 ppm:-`.arrayBuffer());
  const [header = "", width = "0", height = "0"] =
    data
      .subarray(0, 32)
      .toString("latin1")
      .match(/^P6\s+(\d+)\s+(\d+)\s+255\s/) ?? [];
  return { width: Number(width), height: Number(height), pixels: data.subarray(header.length) };
}

export async function compare(expected: string, actual: string, diffs: string): Promise<Difference[]> {
  await mkdir(diffs, { recursive: true });
  const list = async (dir: string) => new Set((await readdir(dir)).filter((file) => file.endsWith(".png")));
  const [left, right] = await Promise.all([list(expected), list(actual)]);
  const names = [...new Set([...left, ...right])].sort();
  return Promise.all(
    names.map(async (file): Promise<Difference> => {
      const name = file.slice(0, -4);
      if (!left.has(file) || !right.has(file)) return { name, pixels: -1, note: `missing in ${left.has(file) ? actual : expected}` };
      if (Buffer.compare(await Bun.file(`${expected}/${file}`).bytes(), await Bun.file(`${actual}/${file}`).bytes()) === 0)
        return { name, pixels: 0, note: "" };
      const [a, b] = await Promise.all([decode(`${expected}/${file}`), decode(`${actual}/${file}`)]);
      if (a.width !== b.width || a.height !== b.height) return { name, pixels: -1, note: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
      const diff = Buffer.alloc(a.pixels.length);
      const box = { left: a.width, top: a.height, right: -1, bottom: -1 };
      let pixels = 0;
      for (let index = 0; index < a.pixels.length; index += 3) {
        const color = a.pixels.readUIntBE(index, 3);
        if (color === b.pixels.readUIntBE(index, 3)) diff.fill(((color >> 16) + ((color >> 8) & 255) + (color & 255)) / 12 + 160, index, index + 3);
        else {
          const [x, y] = [(index / 3) % a.width, Math.floor(index / 3 / a.width)];
          Object.assign(box, { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) });
          pixels++;
          diff.set([255, 0, 0], index);
        }
      }
      if (!pixels) return { name, pixels, note: "" };
      await $`magick -size ${a.width}x${a.height} -depth 8 rgb:- ${diffs}/${file} < ${diff}`;
      return { name, pixels, note: `${pixels} px in ${box.right - box.left + 1}x${box.bottom - box.top + 1}+${box.left}+${box.top}` };
    }),
  );
}

if (import.meta.main) {
  const [expected, actual, diffs = `${actual}-diff`] = process.argv.slice(2);
  if (!expected || !actual) throw new Error("Usage: bun tests/e2e/compare.ts <expected-dir> <actual-dir> [diff-dir]");
  const differences = await compare(expected, actual, diffs);
  await Bun.write(`${diffs}/summary.json`, JSON.stringify(differences, null, 2));
  for (const { name, pixels, note } of differences) console.log(`${pixels === 0 ? "ok  " : "DIFF"} ${name.padEnd(40)} ${note || "0 px"}`);
  const json = async <T>(dir: string, file: string): Promise<Record<string, T>> =>
    (await Bun.file(`${dir}/${file}`).exists()) ? Bun.file(`${dir}/${file}`).json() : {};
  const [before, after] = await Promise.all([json<unknown>(expected, "effects.json"), json<unknown>(actual, "effects.json")]);
  const effects = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => !Bun.deepEquals(before[name], after[name]));
  for (const name of effects) console.log(`EFFECTS ${name}: ${JSON.stringify(before[name])} vs ${JSON.stringify(after[name])}`);
  const [slow, fast] = await Promise.all([json<Timing>(expected, "timing.json"), json<Timing>(actual, "timing.json")]);
  for (const [name, { ready, total }] of Object.entries(slow)) {
    const other = fast[name];
    if (other) console.log(`time ${name.padEnd(30)} ready ${ready} -> ${other.ready} ms, total ${total} -> ${other.total} ms`);
  }
  const failed = differences.filter(({ pixels }) => pixels !== 0).length;
  console.log(`${differences.length - failed}/${differences.length} screenshots identical, ${effects.length} side-effect differences; diff images in ${diffs}`);
  process.exit(failed || effects.length ? 1 : 0);
}
