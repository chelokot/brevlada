import { readdir } from "node:fs/promises";

const [references, candidates] = Bun.argv.slice(2).map((runs) => runs.split(","));
if (!references || !candidates) throw new Error("Usage: bun tests/e2e/variants.ts <reference runs,...> <candidate runs,...>");

const hashes = async (runs: string[], name: string) =>
  new Set(await Promise.all(runs.map(async (run) => Bun.hash(await Bun.file(`${run}/${name}`).bytes()).toString())));

const names = (await readdir(references[0]!)).filter((name) => name.startsWith("animation-") && name.endsWith(".png")).sort();
let stable = 0;
const varying: string[] = [];
const unmatched: string[] = [];
for (const name of names) {
  const [expected, actual] = await Promise.all([hashes(references, name), hashes(candidates, name)]);
  if ([...actual].some((hash) => !expected.has(hash))) unmatched.push(name);
  else if (expected.size > 1 || actual.size > 1) varying.push(name);
  else stable++;
}
for (const name of varying) console.log(`vary ${name}`);
for (const name of unmatched) console.log(`DIFF ${name}`);
console.log(`${names.length} animation frames: ${stable} identical in every run, ${varying.length} vary between runs of each build within the reference's variants, ${unmatched.length} unmatched`);
process.exit(unmatched.length ? 1 : 0);
