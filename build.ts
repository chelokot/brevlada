import { gi } from "./src/gi/plugin";

const { success, logs } = await Bun.build({
  entrypoints: ["src/main.ts", "src/backend/service.ts", "src/backend/search/worker.ts"],
  root: "src",
  compile: { outfile: "dist/brevlada", autoloadDotenv: false, autoloadBunfig: false },
  bytecode: true,
  format: "esm",
  minify: true,
  plugins: [gi],
});
if (!success) throw new AggregateError(logs, "Build failed");
