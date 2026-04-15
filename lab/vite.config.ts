import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { createReadStream, existsSync, readdirSync } from "fs";
import { exec } from "child_process";

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
                next();
            });
        },
    };
}

/** Fetch subproject report data from GitHub Issues via gh CLI */
function serveReportData(): Plugin {
    interface ReportEntry {
        num: number;
        title: string;
        assignee: string;
        done: number;
        total: number;
    }
    let cache: { data: ReportEntry[]; fetchedAt: string } | null = null;
    let fetching = false;

    function fetchReport(): Promise<{ data: ReportEntry[]; fetchedAt: string }> {
        return new Promise((resolve) => {
            fetching = true;
            exec(
                'gh issue list --repo BabylonJS/Babylon-Lite --label "sub-project" --state all --json number,title,body,assignees --limit 100',
                { timeout: 30_000 },
                (err, stdout) => {
                    fetching = false;
                    if (err) {
                        console.warn("[report] gh CLI failed:", err.message);
                        resolve(cache ?? { data: [], fetchedAt: "" });
                        return;
                    }
                    try {
                        const issues = JSON.parse(stdout) as {
                            number: number;
                            title: string;
                            body?: string;
                            assignees?: { login: string }[];
                        }[];
                        const data: ReportEntry[] = issues
                            .sort((a, b) => a.number - b.number)
                            .map((i) => {
                                const body = i.body ?? "";
                                const total = (body.match(/- \[[ x]\]/g) ?? []).length;
                                const done = (body.match(/- \[x\]/g) ?? []).length;
                                const assignee = i.assignees?.[0]?.login ?? "unassigned";
                                return { num: i.number, title: i.title, assignee, done, total };
                            });
                        cache = { data, fetchedAt: new Date().toISOString() };
                        resolve(cache);
                    } catch {
                        console.warn("[report] Failed to parse gh output");
                        resolve(cache ?? { data: [], fetchedAt: "" });
                    }
                },
            );
        });
    }

    return {
        name: "serve-report-data",
        configureServer(server) {
            // Eagerly fetch on server start (non-blocking)
            fetchReport();

            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0];

                if (url === "/api/report.json" && req.method === "GET") {
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Cache-Control", "no-cache");
                    if (cache) {
                        res.end(JSON.stringify(cache));
                    } else if (fetching) {
                        // Wait for the in-flight fetch to complete
                        fetchReport().then((result) => res.end(JSON.stringify(result)));
                    } else {
                        fetchReport().then((result) => res.end(JSON.stringify(result)));
                    }
                    return;
                }

                if (url === "/api/report-refresh" && req.method === "POST") {
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Cache-Control", "no-cache");
                    fetchReport().then((result) => res.end(JSON.stringify(result)));
                    return;
                }

                next();
            });
        },
    };
}

export default defineConfig({
    plugins: [serveReferenceImages(), serveReportData()],
    optimizeDeps: {
        // BJS uses prototype-patching side-effect imports (e.g. abstractEngine.dom.js).
        // babylon-lite uses ?raw WGSL imports that esbuild can't handle.
        // Exclude both from Vite's dep optimizer.
        exclude: ["@babylonjs/core", "@babylonjs/loaders"],
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
