export { run } from "./application";
export { defineClass } from "./runtime";

const standalone = import.meta.url.startsWith("file:///$bunfs/");

export const spawn = (url: URL) => new Worker(url, standalone ? {} : { preload: [new URL("./plugin.ts", import.meta.url).href] });
