import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No build-id/stale-bundle plugin here unlike Hub/web's vite.config.ts:
// that plugin exists because Hub runs as an always-on service that a crash
// can respawn without rebuilding the frontend first. Athena's installer
// (installers/bootstrap.mjs) always rebuilds web/ right before starting the
// server on every launch, so a running server and its served bundle can
// never disagree the way Hub's can.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.ATHENA_PORT || 4417}`,
    },
  },
});
