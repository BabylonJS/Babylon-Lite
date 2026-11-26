/**
 * Eager-chunk guard for the Lite Playground's self-hosted engine (`playground/vite.engine.config.ts`).
 *
 * The runner import-maps `@babylonjs/lite` to that build's `index.js`, so the browser fetches the entry's
 * static import graph before any snippet runs. Without the config's `engine` code-splitting group, Rolldown
 * splits that graph into ~160 small chunks. Many modules are both exported eagerly and lazily imported, and
 * lib mode's strict entry signature prevents Rolldown from merging those chunks back into the entry. An
 * empty scene then made ~160 requests. See
 * https://forum.babylonjs.com/t/lite-something-wrong-with-treeshaking-bundling-with-vite/64889.
 */
import { resolve } from "path";
import { build, createLogger, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";

const ENGINE_CONFIG = resolve(__dirname, "../../../playground/vite.engine.config.ts");

/** Entry facade, the single eager `engine` chunk, and Rolldown's tiny runtime helper chunk. */
const MAX_EAGER_FILES = 3;

/** Representative heavy optional runtimes that must stay behind dynamic imports, matched by module ID. */
const OPTIONAL_RUNTIMES: ReadonlyArray<readonly [string, RegExp]> = [
    ["Manifold (CSG)", /[\\/]node_modules[\\/]manifold-3d[\\/]/],
    ["Recast (navigation)", /[\\/]node_modules[\\/]@recast-navigation[\\/]/],
];

describe("Lite Playground engine bundle", () => {
    it("loads the engine through a handful of eager chunks, keeping lazy features lazy", async () => {
        const result = (await build({
            configFile: ENGINE_CONFIG,
            logLevel: "silent",
            customLogger: createLogger("silent"),
            build: { write: false, sourcemap: false, minify: false },
        })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
        const output = (Array.isArray(result) ? result[0]! : result).output;
        const chunks = new Map(output.filter((o): o is Rolldown.OutputChunk => o.type === "chunk").map((chunk) => [chunk.fileName, chunk]));
        const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
        expect(entry?.fileName).toBe("index.js");

        const reachableFrom = (includeDynamic: boolean): Set<string> => {
            const reached = new Set<string>();
            const queue = [entry!.fileName];
            while (queue.length > 0) {
                const name = queue.pop()!;
                if (!reached.has(name)) {
                    reached.add(name);
                    const chunk = chunks.get(name);
                    queue.push(...(chunk?.imports ?? []), ...(includeDynamic ? (chunk?.dynamicImports ?? []) : []));
                }
            }
            return reached;
        };
        const eager = reachableFrom(false);
        const reachable = reachableFrom(true);
        const eagerFiles = [...eager].sort();
        expect(eagerFiles.length, `index.js statically loads ${eagerFiles.length} files:\n${eagerFiles.join("\n")}`).toBeLessThanOrEqual(MAX_EAGER_FILES);

        for (const [feature, modulePattern] of OPTIONAL_RUNTIMES) {
            const featureChunks = [...chunks.values()].filter((chunk) => chunk.moduleIds.some((id) => modulePattern.test(id))).map((chunk) => chunk.fileName);
            expect(featureChunks, `${feature} runtime should be emitted`).not.toEqual([]);
            expect(
                featureChunks.filter((name) => eager.has(name)),
                `${feature} runtime must not load with index.js`
            ).toEqual([]);
            expect(
                featureChunks.some((name) => reachable.has(name)),
                `${feature} runtime must stay reachable through a dynamic import`
            ).toBe(true);
        }
    }, 180_000);
});
