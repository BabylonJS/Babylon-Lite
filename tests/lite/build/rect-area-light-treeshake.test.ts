import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rollup } from "rollup";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const entry = resolve(root, "packages/babylon-lite/build/lib/index.js");
const declaration = resolve(root, "packages/babylon-lite/build/index.d.ts");

beforeAll(() => {
    if (!existsSync(entry) || !existsSync(declaration)) {
        throw new Error("Build babylon-lite's lib and dist declarations before running the focused area-light build tests.");
    }
});

async function bundle(imports: string, expression: string): Promise<string> {
    const virtual = "virtual:rect-area-light-probe";
    const result = await rollup({
        input: virtual,
        treeshake: { moduleSideEffects: false },
        external: (id) => /[/\\]_chunks[/\\]vendor[/\\]|\.wasm(?:\?|$)|\?url|^(?:node:)?(?:module|fs|path|url|os|crypto)$/.test(id),
        plugins: [
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
        const output = await result.generate({ format: "es", inlineDynamicImports: true });
        return output.output
            .filter((chunk) => chunk.type === "chunk")
            .map((chunk) => chunk.code)
            .join("\n");
    } finally {
        await result.close();
    }
}

describe("rectangular area-light shipped API and opt-in boundary", () => {
    it("emits byte-identical punctual code when area exports are imported but unused", async () => {
        const baseline = await bundle("createPointLight", "createPointLight");
        const unused = await bundle("createPointLight, createRectAreaLight, enableRectAreaLights", "createPointLight");
        expect(unused).toBe(baseline);
        expect(unused).not.toContain("areaLightsLTC.bin");
        expect(unused).not.toContain("evaluateAreaLtc");
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
    });

    it("exports a pure-state rectangle interface without internal callbacks or GPU handles in trimmed declarations", () => {
        const source = ts.createSourceFile(declaration, readFileSync(declaration, "utf8"), ts.ScriptTarget.Latest, true);
        const light = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === "RectAreaLight");
        expect(light).toBeDefined();
        const fields = light!.members.map((member) => member.name?.getText(source));
        expect(fields).toEqual(["lightType", "width", "height", "diffuse", "specular", "intensity"]);
        expect(light!.members.every(ts.isPropertySignature)).toBe(true);
        expect(light!.getText(source)).not.toMatch(/GPU|_cloneNode|_writeLightUbo|SceneContext/);
        const names = source.statements.filter(ts.isFunctionDeclaration).map((statement) => statement.name?.text);
        expect(names).toContain("createRectAreaLight");
        expect(names).toContain("enableRectAreaLights");
        const sourcePackage = JSON.parse(readFileSync(resolve(root, "packages/babylon-lite/package.json"), "utf8")) as { exports: Record<string, unknown> };
        const shippedPackage = JSON.parse(readFileSync(resolve(root, "packages/babylon-lite/build/package.json"), "utf8")) as { exports: Record<string, unknown> };
        expect(Object.keys(sourcePackage.exports)).toEqual(["."]);
        expect(Object.keys(shippedPackage.exports)).toEqual(["."]);
    });
});
