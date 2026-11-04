import { build } from "vite";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../packages/babylon-lite/src");

async function bundle(exports: ReadonlyArray<readonly [string, string[]]>) {
    const entry = "virtual:recovery-boundary";
    const source = exports.map(([module, names]) => `export { ${names.join(", ")} } from ${JSON.stringify(resolve(SRC, module))};`).join("\n");
    const result = await build({
        configFile: false,
        publicDir: false,
        logLevel: "silent",
        plugins: [
            {
                name: "recovery-boundary-entry",
                resolveId: (id) => (id === entry ? `\0${entry}` : undefined),
                load: (id) => (id === `\0${entry}` ? source : undefined),
            },
        ],
        build: {
            write: false,
            minify: false,
            target: "esnext",
            rollupOptions: { input: entry, preserveEntrySignatures: "strict", output: { format: "es" } },
        },
    });
    if (!Array.isArray(result) && !("output" in result)) {
        throw new Error("Expected build output, not a watcher");
    }
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output).filter((output) => output.type === "chunk");
    return {
        code: chunks.map((chunk) => chunk.code).join("\n"),
        modules: chunks.flatMap((chunk) => Object.keys(chunk.modules)),
    };
}

describe("device-lost recovery is opt-in", () => {
    it("keeps dynamic texture recovery semantics out of a consumer without recovery", async () => {
        const { code, modules } = await bundle([["texture/dynamic-texture.ts", ["createDynamicTexture", "updateDynamicTexture"]]]);
        expect(code).toContain("createDynamicTexture");
        expect(code).toContain("updateDynamicTexture");
        expect(code).not.toContain("_recoverySource");
        expect(code).not.toMatch(/kind:\s*["']dynamic["']/);
        expect(modules.filter((id) => /device-lost|texture-recovery/.test(id))).toEqual([]);
    });

    it.each([
        ["background-ground", "buildGroundRenderable"],
        ["background-solid-skybox", "buildSolidSkyboxRenderable"],
        ["background-hdr-skybox", "buildHdrSkyboxRenderable"],
        ["background-dds-skybox", "buildDdsSkyboxRenderable"],
    ])("keeps recovery closure construction out of %s without recovery", async (module, name) => {
        const { code, modules } = await bundle([[`material/pbr/${module}.ts`, [name]]]);
        expect(code).toContain(name);
        expect(code).not.toMatch(/\._rebuild\b/);
        expect(modules.filter((id) => /device-lost|recovery-rebuild/.test(id))).toEqual([]);
    });

    it("retains capture semantics when the consumer explicitly imports a recovery enabler", async () => {
        const { code, modules } = await bundle([
            ["texture/dynamic-texture.ts", ["createDynamicTexture", "updateDynamicTexture"]],
            ["engine/device-lost-scene-recovery.ts", ["enableDeviceLostSceneRecovery"]],
        ]);
        expect(code).toContain("_recoverySource");
        expect(code).toMatch(/kind:\s*["']dynamic["']/);
        expect(modules.some((id) => id.includes("device-lost-recovery-capture"))).toBe(true);
    });
});
