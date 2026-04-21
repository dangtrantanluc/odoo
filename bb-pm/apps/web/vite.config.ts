import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@bb-pm/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    host: true,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 4000}`,
        changeOrigin: true,
      },
    },
  },
});
