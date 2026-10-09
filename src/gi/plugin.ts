import { plugin, type BunPlugin } from "bun";

const module = (name: string) => JSON.stringify(Bun.fileURLToPath(new URL(name, import.meta.url)));

export const gi: BunPlugin = {
  name: "gi",
  setup(build) {
    build.onResolve({ filter: /^gi:\/\// }, ({ path }) => ({ path, namespace: "gi" }));
    build.onLoad({ filter: /.*/, namespace: "gi" }, ({ path }) => {
      const [, name, version] = /(\w+)(?:\?version=([\w.]+))?$/.exec(path) ?? [];
      return {
        contents: `import ${module("./variant.ts")}; import { namespace } from ${module("./runtime.ts")}; export default namespace(${JSON.stringify(name)}, ${JSON.stringify(version ?? null)});`,
        loader: "ts",
      };
    });
  },
};

plugin(gi);
