import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  experimental: {
    // The bundle is built once and served under whatever URL base the container is started with
    // (URL_BASE, web/url-base.sh), so no asset URL inside it can be absolute. Files that JS refers to (the
    // lazy page chunks' preloads, the Swagger files ApiDocs loads) resolve against the chunk that names
    // them, and url() in CSS against the stylesheet. index.html keeps Vite's usual "/assets/..." paths:
    // the start-up script prefixes those when a base is set, and leaves them alone when not.
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === "js" || hostType === "css" ? { relative: true } : undefined;
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8989",
        changeOrigin: true,
      },
    },
  },
});
