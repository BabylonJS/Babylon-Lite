import type { Plugin } from "esbuild";
import { resolve } from "node:path";

/** Preserve Vite's inline-worker processing when a diagnostic bundles a demo in memory. */
export function diagnosticWorkerPlugin(): Plugin {
    return {
        name: "diagnostic-worker-urls",
        setup(build) {
            build.onResolve({ filter: /\?worker&inline$/ }, (args) => {
                const path = resolve(args.resolveDir, args.path.slice(0, -"?worker&inline".length));
                return { path: `/@fs/${path.replaceAll("\\", "/")}?worker&inline`, external: true };
            });
        },
    };
}
