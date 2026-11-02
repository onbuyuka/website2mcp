import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts", vite: "src/vite.ts", astro: "src/astro.ts", handler: "src/handler.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  dts: { entry: { index: "src/index.ts", vite: "src/vite.ts", astro: "src/astro.ts", handler: "src/handler.ts" } },
});
