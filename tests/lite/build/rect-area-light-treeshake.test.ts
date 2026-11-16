import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rollup } from "rollup";
import type { OutputChunk } from "rollup";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { packageImportsPlugin } from "./bundler-harness";

const root = resolve(__dirname, "../../..");
const entry = resolve(root, "packages/babylon-lite/build/lib/index.js");
const declaration = resolve(root, "packages/babylon-lite/build/index.d.ts");

beforeAll(() => {
    if (!existsSync(entry) || !existsSync(declaration)) {
        throw new Error("Build babylon-lite's lib and dist declarations before running the focused area-light build tests.");
    }
});

async function bundleChunks(imports: string, expression: string, inlineDynamicImports: boolean): Promise<OutputChunk[]> {
    const virtual = "virtual:rect-area-light-probe";
    const result = await rollup({
        input: virtual,
        treeshake: { moduleSideEffects: false },
        external: (id) => /[/\\]_chunks[/\\]vendor[/\\]|\.wasm(?:\?|$)|\?url|^(?:node:)?(?:module|fs|path|url|os|crypto)$/.test(id),
        plugins: [
            packageImportsPlugin(),
            {
                name: "in-memory-area-light-probe",
                resolveId(id) {
                    return id === virtual ? virtual : null;
                },
                load(id) {
                    return id === virtual ? `import { ${imports} } from ${JSON.stringify(entry)};\nconsole.log(${expression});` : null;
                },
            },
        ],
        onwarn(warning) {
            if (warning.code !== "CIRCULAR_DEPENDENCY") {
                throw new Error(warning.message);
            }
        },
    });
    try {
        const output = await result.generate({ format: "es", inlineDynamicImports });
        return output.output.filter((chunk): chunk is OutputChunk => chunk.type === "chunk");
    } finally {
        await result.close();
    }
}

async function bundle(imports: string, expression: string): Promise<string> {
    return (await bundleChunks(imports, expression, true)).map((chunk) => chunk.code).join("\n");
}

function staticImportClosure(chunks: readonly OutputChunk[], roots: readonly OutputChunk[]): Set<OutputChunk> {
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const closure = new Set<OutputChunk>();
    const pending = [...roots];
    while (pending.length) {
        const chunk = pending.pop()!;
        if (closure.has(chunk)) {
            continue;
        }
        closure.add(chunk);
        for (const name of chunk.imports) {
            const dependency = byName.get(name);
            if (dependency) {
                pending.push(dependency);
            }
        }
    }
    return closure;
}

describe("rectangular area-light shipped API and opt-in boundary", () => {
    it("emits byte-identical punctual code when area exports are imported but unused", async () => {
        const baseline = await bundle("createPointLight", "createPointLight");
        const unused = await bundle("createPointLight, createRectAreaLight, enableRectAreaLights, processAreaLightTexture", "createPointLight");
        expect(unused).toBe(baseline);
        expect(unused).not.toContain("areaLightsLTC.bin");
        expect(unused).not.toContain("evaluateAreaLtc");
        expect(unused).not.toContain("blurAreaLightPixels");
        expect(unused).not.toContain("areaEmissionForm");
    });

    it("retains scene-free rectangle data but no LUT fetch or shader code when only its factory is consumed", async () => {
        const code = await bundle("createRectAreaLight", "createRectAreaLight");
        expect(code).toContain('lightType: "rectArea"');
        expect(code).not.toContain("areaLightsLTC.bin");
        expect(code).not.toContain("evaluateAreaLtc");
        expect(code).not.toContain("pushErrorScope");
    });

    it("retains exact LTC resource and shader implementation only with the explicit enabler", async () => {
        const code = await bundle("enableRectAreaLights", "enableRectAreaLights");
        expect(code).toContain("https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin");
        expect(code).toContain("evaluateAreaLtc");
        expect(code).toContain("rgba16float");
        expect(code).not.toContain("source was released during emission preprocessing");
        expect(code).not.toContain("texture-pixels-readback");
    });

    it("preprocessing alone retains no scene, LTC lookup fetch, material registration or emitter sampler projection", async () => {
        const chunks = await bundleChunks("processAreaLightTexture", "processAreaLightTexture", false);
        const entries = chunks.filter((chunk) => chunk.isEntry);
        expect(entries).toHaveLength(1);
        const eager = staticImportClosure(chunks, entries);
        const code = [...eager].map((chunk) => chunk.code).join("\n");
        expect(code).toContain("rect-area-emission-scale");
        expect(code).toContain("texture-pixels-readback");
        expect(code).not.toContain("areaLightsLTC.bin");
        expect(code).not.toContain("areaEmissionForm");
        expect(code).not.toContain("registerScene");
        expect(code).not.toContain("createSceneContext");
        expect(code).not.toContain("_registerPbrExt");
        expect(code).not.toContain("_registerStdExt");

        const setup = chunks.find((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith("/light/area-light-emission-setup.js")));
        expect(setup).toBeDefined();
        expect(eager.has(setup!)).toBe(false);
        expect([...eager].flatMap((chunk) => chunk.dynamicImports)).toContain(setup!.fileName);
        const deferredCode = [...staticImportClosure(chunks, [setup!])].map((chunk) => chunk.code).join("\n");
        expect(deferredCode).toContain("areaEmissionForm");
        expect(deferredCode).toContain("_registerPbrExt");
        expect(deferredCode).toContain("_registerStdExt");
    });

    it("exports a pure-state rectangle interface without internal callbacks or GPU handles in trimmed declarations", () => {
        const source = ts.createSourceFile(declaration, readFileSync(declaration, "utf8"), ts.ScriptTarget.Latest, true);
        const light = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === "RectAreaLight");
        expect(light).toBeDefined();
        const fields = light!.members.map((member) => member.name?.getText(source));
        expect(fields).toEqual(["lightType", "width", "height", "diffuse", "specular", "intensity", "emissionTexture"]);
        expect(light!.members.every(ts.isPropertySignature)).toBe(true);
        expect(light!.getText(source)).not.toMatch(/GPU|_cloneNode|_writeLightUbo|SceneContext/);
        const names = source.statements.filter(ts.isFunctionDeclaration).map((statement) => statement.name?.text);
        expect(names).toContain("createRectAreaLight");
        expect(names).toContain("enableRectAreaLights");
        expect(names).toContain("processAreaLightTexture");
        const processor = source.statements.find(
            (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "processAreaLightTexture"
        )!;
        expect(processor.parameters.map((parameter) => parameter.type!.getText(source))).toEqual(["EngineContext", "Texture2D"]);
        expect(processor.type!.getText(source)).toBe("Promise<Texture2D>");
        expect(processor.getText(source)).not.toMatch(/GPU|SceneContext/);
        const sourcePackage = JSON.parse(readFileSync(resolve(root, "packages/babylon-lite/package.json"), "utf8")) as { exports: Record<string, unknown> };
        const shippedPackage = JSON.parse(readFileSync(resolve(root, "packages/babylon-lite/build/package.json"), "utf8")) as { exports: Record<string, unknown> };
        expect(Object.keys(sourcePackage.exports)).toEqual(["."]);
        expect(Object.keys(shippedPackage.exports)).toEqual(["."]);
    });
});
