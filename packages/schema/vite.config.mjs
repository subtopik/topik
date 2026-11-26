import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/*/v*.ts", "!src/**/*.test.ts"],
    copy: [{ from: "src/*/v*.json", to: "dist", flatten: false }],
    dts: true,
  },
  test: {
    // Loaded CI runners are several times slower than a local run.
    testTimeout: 20_000,
  },
  fmt: {},
});
