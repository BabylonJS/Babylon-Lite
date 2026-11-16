import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

describe("indexed indirect public API and opt-in boundary", () => {
    it.each([false, true])("retains borrowed draw validation only when explicitly imported (%s)", async (enabled) => {
        const imports = `createEngine, startEngine, createSceneContext, registerScene, createShaderMaterial, createMeshFromStorageBuffer${enabled ? ", setMeshIndexedIndirect" : ""}`;
        const result = await runRollup({
            entrySource: `import { ${imports} } from ${JSON.stringify(LIB_ENTRY)}; console.log(${imports});`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code.includes("function setMeshIndexedIndirect")).toBe(enabled);
        expect(result.code.includes("function findSource")).toBe(enabled);
        expect(result.code.includes("drawIndexedIndirect(validate(")).toBe(enabled);
    });

    it("exposes opaque storage borrowing and nullable GPU counts through the trimmed root declaration", () => {
        const path = resolve(LIB_ENTRY, "../../index.d.ts");
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        const functionNames = ["setMeshIndexedIndirect", "getMeshIndexedDrawInfo"];
        for (const name of functionNames) {
            const declaration = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
            expect(declaration, name).toBeDefined();
            expect(declaration!.getText(source)).not.toMatch(/GPUBuffer|GPUDevice/);
        }
        const binding = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "setMeshIndexedIndirect")!;
        expect(binding.getText(source)).toMatch(/buffer: StorageBuffer \| null/);
        expect(binding.getText(source)).toMatch(/byteOffset\?: number/);
        const info = source.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "MeshIndexedDrawInfo")!;
        expect(info.getText(source)).toMatch(/readonly indexCount: number \| null/);
        expect(info.getText(source)).toMatch(/readonly instanceCount: number \| null/);
        expect(info.getText(source)).not.toMatch(/_buffer|GPUBuffer/);
    });
});
