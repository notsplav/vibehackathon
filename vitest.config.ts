import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "extension", include: ["extension/test/**/*.test.ts"], environment: "jsdom" },
      },
      {
        test: { name: "server", include: ["server/test/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
