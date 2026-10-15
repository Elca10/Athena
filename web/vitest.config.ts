import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    // Multi-step UI journeys take a few seconds each, and under a full
    // parallel run on a slow machine they kept tripping the 5s default.
    // Still short enough to catch a real hang.
    testTimeout: 15_000,
  },
});
