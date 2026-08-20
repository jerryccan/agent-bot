import { defineConfig } from "vitest/config";

export default defineConfig({
  test: process.platform === "win32" ? { maxWorkers: 1 } : {},
});
