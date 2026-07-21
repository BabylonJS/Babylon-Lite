import { defineConfig } from "vite";

/**
 * The Lite Playground app (editor + runner shell). The self-hosted engine under
 * `public/engine/dev/` is produced separately by `vite.engine.config.ts` (run via
 * the `build:engine` script) and served as a static asset; this build only owns
 * the playground UI.
 */
export default defineConfig({
    // Deploy base path. Root ("/") for the canonical nightly deploy; per-PR and
    // per-version snapshots are served under a sub-path (e.g. "/pr/123/",
    // "/v/1.4.0/") set via PLAYGROUND_BASE so all assets, the runner iframe, the
    // self-hosted engine, and SPA snippet routes resolve relative to that prefix.
    // Must start and end with a slash.
    base: process.env.PLAYGROUND_BASE ?? "/",
    server: {
        // Bind both IPv4 and IPv6 loopback. Vite's default `localhost` can bind
        // only one stack (we saw it land on IPv6 ::1 only), so a browser that
        // resolves localhost -> 127.0.0.1 gets a refused connection and a blank
        // page. `host: true` listens on all interfaces, covering both stacks.
        host: true,
        port: 5175,
        // Fail loudly if 5175 is taken instead of silently drifting to another
        // port (which makes the printed URL not match what you opened).
        strictPort: true,
        proxy: {
            // Same-origin proxy to the Babylon snippet server. The server only
            // accepts `application/json` saves and its CORS preflight is
            // origin-allow-listed (localhost is rejected), so we proxy
            // server-side in dev to bypass the browser preflight. The prefix is
            // `/snippet-api` (not `/snippet`) so the `/snippet/ID/v/VERSION` app
            // routes fall through to Vite's SPA fallback instead of the proxy.
            "/snippet-api": {
                target: "https://snippet.babylonjs.com",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/snippet-api/, ""),
            },
        },
    },
    build: {
        target: "esnext",
        sourcemap: true,
        rollupOptions: {
            output: {
                // `index.html` is the sole entry, and Rollup only invokes
                // `entryFileNames` for entry chunks — so the app's entry (the
                // coordinator in entry.ts) is emitted as a stable, unhashed
                // `assets/boot.js`. Any deploy can then hand off to another
                // snapshot's coordinator via a predictable `<base>assets/boot.js`.
                // Every other chunk and asset stays content-hashed for long-term
                // immutable caching.
                entryFileNames: "assets/boot.js",
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
    worker: {
        format: "es",
    },
});
