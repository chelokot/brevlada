export { run } from "./application";
export { defineClass } from "./runtime";

export const spawn = (url: URL) => new Worker(url, { preload: [new URL("./plugin.ts", import.meta.url).href] });
