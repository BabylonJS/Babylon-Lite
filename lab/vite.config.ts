import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";

/** Serve reference images from the repo-root reference/ directory */
function serveReferenceImages(): Plugin {
    return {
        name: "serve-reference-images",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0]; // strip query string
                if (url.startsWith("/reference/")) {
                    const filePath = resolve(__dirname, "..", url.slice(1));
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "image/png");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                if (url === "/scene-config.json") {
                    const filePath = resolve(__dirname, "../scene-config.json");
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                if (url === "/lab-api/signature") {
                    // Returns mtimes for bundle / perf manifests and per-scene parity images
                    // so the dashboard can auto-refresh only when data actually changes.
                    const sig: {
                        bundle: number | null;
                        perf: number | null;
                        parity: Record<string, number>;
                    } = { bundle: null, perf: null, parity: {} };
                    const mtime = (p: string): number | null => {
                        try {
                            return existsSync(p) ? statSync(p).mtimeMs : null;
                        } catch {
                            return null;
                        }
                    };
                    sig.bundle = mtime(resolve(__dirname, "public/bundle/manifest.json"));
                    sig.perf = mtime(resolve(__dirname, "public/perf-manifest.json"));
                    try {
                        const cfgPath = resolve(__dirname, "../scene-config.json");
                        if (existsSync(cfgPath)) {
                            const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Array<{ id: number; slug: string }>;
                            for (const s of cfg) {
                                const imgPath = resolve(__dirname, "../reference", s.slug, "test-actual.png");
                                const m = mtime(imgPath);
                                if (m != null) sig.parity["scene" + s.id] = m;
                            }
                        }
                    } catch {
                        // ignore
                    }
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(JSON.stringify(sig));
                    return;
                }
                next();
            });
        },
    };
}

export default defineConfig({
    plugins: [serveReferenceImages()],
    optimizeDeps: {
        // BJS uses prototype-patching side-effect imports (e.g. abstractEngine.dom.js).
        // babylon-lite uses ?raw WGSL imports that esbuild can't handle.
        // Exclude both from Vite's dep optimizer.
        exclude: ["@babylonjs/core", "@babylonjs/loaders", "@babylonjs/havok"],
    },
    resolve: {
        // Ensure @babylonjs/core resolves to a single instance (loaders registers
        // plugins on the same SceneLoader the scene code imports).
        dedupe: ["@babylonjs/core"],
        alias: {
            // Point babylon-lite directly at the TypeScript source directory so Vite treats
            // it as first-party code: full HMR + native ?raw WGSL handling.
            // Directory alias so sub-path imports like 'babylon-lite/loader-env/...' work too.
            "babylon-lite": resolve(__dirname, "../packages/babylon-lite/src"),
        },
    },
    server: {
        port: 5174,
    },
    build: {
        rollupOptions: {
            input: Object.fromEntries([
                ["main", resolve(__dirname, "index.html")],
                ...readdirSync(__dirname)
                    .filter((f) => f.endsWith(".html") && f !== "index.html")
                    .map((f) => [f.replace(".html", ""), resolve(__dirname, f)]),
            ]),
        },
    },
});
