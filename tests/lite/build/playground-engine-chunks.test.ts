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

        const eager = new Set<string>();
        const queue = [entry!.fileName];
        while (queue.length > 0) {
            const name = queue.pop()!;
            if (!eager.has(name)) {
                eager.add(name);
                queue.push(...(chunks.get(name)?.imports ?? []));
            }
        }
        const eagerFiles = [...eager].sort();
        expect(eagerFiles.length, `index.js statically loads ${eagerFiles.length} files:\n${eagerFiles.join("\n")}`).toBeLessThanOrEqual(MAX_EAGER_FILES);
        expect(chunks.size, "lazy features must stay in separate dynamic chunks").toBeGreaterThan(100);
    }, 180_000);
});
