import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
