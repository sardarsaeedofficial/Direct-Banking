import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend build. Output is copied into the Express server's public/ folder by
// the root `copy:web` script so a single Node process serves everything.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // During `pnpm dev` the API runs separately; proxy /api to it.
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
