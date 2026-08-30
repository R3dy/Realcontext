import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { plugin: "src/plugin.ts", cli: "src/cli.ts", index: "src/index.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    splitting: false,
    sourcemap: false,
    dts: false,
    clean: true,
    external: ["node:sqlite"],
  },
])
