import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/*/v*.ts", "!src/**/*.test.ts"],
    copy: [{ from: "src/*/v*.json", to: "dist", flatten: false }],
    dts: {
      tsgo: true,
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
