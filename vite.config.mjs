import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "tools/release/**"],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
