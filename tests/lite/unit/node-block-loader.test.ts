import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createNodeMaterialBlockLoader } from "../../../packages/babylon-lite/src/material/node/node-block-loader";
import * as catalog from "../../../packages/babylon-lite/src/material/node/node-blocks";
import { emitGraph, loadGraphEmitters } from "../../../packages/babylon-lite/src/material/node/node-emitter";
import { findBlockByClassName, parseNodeMaterialSource } from "../../../packages/babylon-lite/src/material/node/node-parser";
import { loadBlockEmitter } from "../../../packages/babylon-lite/src/material/node/node-registry";
import { loadNodeBlockEmitterWithGeometry } from "../../../packages/babylon-lite/src/material/node/node-geometry-block-loader";
import { generateNodeMaterialLoader } from "../../../scripts/generate-node-material-loader.mjs";
import { SCENE62_NME_JSON } from "../../../lab/lite/src/shared/scene62-nme";
import { getScene66Nme } from "../../../lab/lite/src/shared/scene66-nme";
import { getScene72Nme } from "../../../lab/lite/src/shared/scene72-nme";
import { SCENE88_NME_JSON } from "../../../lab/lite/src/shared/scene88-nme";
import { SCENE149_NME_JSON } from "../../../lab/lite/src/shared/scene149-nme";

async function generatedSelection(source: unknown) {
    const code = await generateNodeMaterialLoader(source);
    const ast = ts.createSourceFile("loader.ts", code, ts.ScriptTarget.Latest, true);
    const selection = new Map(Object.entries(catalog));
    const names: string[] = [];
    for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) {
            continue;
        }
        expect((statement.moduleSpecifier as ts.StringLiteral).text).toBe("@babylonjs/lite");
        const bindings = statement.importClause!.namedBindings!;
        if (ts.isNamedImports(bindings)) {
            names.push(...bindings.elements.map((element) => element.name.text).filter((name) => name !== "createNodeMaterialBlockLoader"));
        }
    }
    expect(code).not.toMatch(/babylon-lite\/material/);
    return {
        names,
        loader: createNodeMaterialBlockLoader(
            names.map((name) => {
                const block = selection.get(name);
                if (!block) {
                    throw new Error(`Generated unknown block: ${name}`);
                }
                return block;
            })
        ),
    };
}

describe("Static Node Material block selections", () => {
    it("covers every class routed by the default registry", () => {
        const path = fileURLToPath(new URL("../../../packages/babylon-lite/src/material/node/node-registry.ts", import.meta.url));
        const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        const keys = new Set(["GeometryTextureOutputBlock"]);
        const visit = (node: ts.Node): void => {
            if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
                keys.add(node.expression.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        const selected = Object.entries(catalog).map(([name, block]) => (name.endsWith("Full") ? `${block.className}__full` : block.className));
        expect(selected.sort()).toEqual([...keys].sort());
    });

    it.each(Object.entries(catalog))("matches the existing %s implementation", async (name, block) => {
        const key = name.endsWith("Full") ? `${block.className}__full` : block.className;
        const expected = key === "GeometryTextureOutputBlock" ? await loadNodeBlockEmitterWithGeometry(key) : await loadBlockEmitter(key);
        const selected = await createNodeMaterialBlockLoader([block])(block.className);
        expect(selected).toBe(expected);
    });

    it("rejects duplicate selections and never falls back for unknown blocks", async () => {
        expect(() => createNodeMaterialBlockLoader([catalog.nodePbrMetallicRoughnessBlock, catalog.nodePbrMetallicRoughnessBlockFull])).toThrow("duplicate block selection");
        const loader = createNodeMaterialBlockLoader([catalog.nodeInputBlock]);
        await expect(loader("TextureBlock")).rejects.toThrow('no emitter selected for block "TextureBlock"');
        await expect(loader("constructor")).rejects.toThrow('no emitter selected for block "constructor"');
    });

    it("rejects a public-shaped descriptor without its internal loader at construction", () => {
        // @ts-expect-error The published interface omits this internal requirement.
        expect(() => createNodeMaterialBlockLoader([{ className: "TextureBlock" }])).toThrow('invalid block selection "TextureBlock"');
    });

    it.each([undefined, null, 42, "loader"])("rejects a non-callable internal loader (%s) at construction", (load) => {
        // @ts-expect-error JavaScript callers can supply malformed internal fields.
        expect(() => createNodeMaterialBlockLoader([{ className: "TextureBlock", _load: load }])).toThrow('invalid block selection "TextureBlock"');
    });

    it.each(["MatrixBuilder", "MatrixSplitterBlock", "MatrixTransposeBlock", "MatrixDeterminantBlock"])("generates a loader for %s", async (className) => {
        const source = { blocks: [{ id: 1, name: "matrix", customType: `BABYLON.${className}`, inputs: [], outputs: [] }] };
        const { names, loader } = await generatedSelection(source);
        expect(names).toEqual([`node${className}`]);
        expect(await loader(className)).toBe(await loadBlockEmitter(className));
    });

    it("generates the same shader and metadata for representative fixed graphs", async () => {
        const sources = [SCENE62_NME_JSON, (await getScene66Nme()).json, await getScene72Nme(), SCENE88_NME_JSON, SCENE149_NME_JSON];
        for (const source of sources) {
            const graph = parseNodeMaterialSource(source);
            const geometry = findBlockByClassName(graph, "GeometryTextureOutputBlock");
            const expected = geometry ? await loadGraphEmitters(graph, loadNodeBlockEmitterWithGeometry) : await loadGraphEmitters(graph);
            const { loader } = await generatedSelection(source);
            const actual = await loadGraphEmitters(graph, loader);
            expect(actual).toEqual(expected);
            const vertex = findBlockByClassName(graph, "VertexOutputBlock");
            for (const root of [findBlockByClassName(graph, "FragmentOutputBlock"), geometry]) {
                if (root) {
                    expect(emitGraph(graph, actual, root.id, vertex?.id ?? null)).toEqual(emitGraph(graph, expected, root.id, vertex?.id ?? null));
                }
            }
        }
    });

    it("preserves core/full PBR selection, including disconnected advanced blocks", async () => {
        const basic = { customType: "BABYLON.PBRMetallicRoughnessBlock", id: 1, name: "pbr", inputs: [], outputs: [] };
        expect((await generatedSelection({ blocks: [basic] })).names).toEqual(["nodePbrMetallicRoughnessBlock"]);
        const advanced = { ...basic, enableSpecularAntiAliasing: true };
        expect((await generatedSelection({ blocks: [basic, { ...advanced, id: 2 }] })).names).toEqual(["nodePbrMetallicRoughnessBlockFull"]);
        const connected = { ...basic, inputs: [{ name: "clearcoat", targetBlockId: 2, targetConnectionName: "clearcoat" }] };
        expect((await generatedSelection({ blocks: [connected] })).names).toEqual(["nodePbrMetallicRoughnessBlockFull"]);
    });

    it("rejects invalid sources and unsupported serialized blocks", async () => {
        await expect(generateNodeMaterialLoader({})).rejects.toThrow("expected `.blocks` array");
        await expect(generateNodeMaterialLoader({ blocks: [{ customType: "BABYLON.UnsupportedBlock", id: 1, name: "unknown" }] })).rejects.toThrow("no emitter registered");
    });
});
