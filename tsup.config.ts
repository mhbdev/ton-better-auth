import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  tsconfig: "tsconfig.build.json",
  clean: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
  external: [
    "better-auth",
    "@better-auth/core",
    "@ton/core",
    "@ton/crypto",
    "@ton/ton",
    "tweetnacl",
    "zod",
  ],
});
