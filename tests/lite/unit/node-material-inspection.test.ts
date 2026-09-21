import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
    MaterialInspectionMutationScope,
    MaterialInspectionPropertyId,
    MaterialInspectionPropertyValue,
    MaterialTextureBindingId,
} from "../../../packages/babylon-lite/src/inspection/inspection-types";
import {
    inspectMaterialWithFamily,
    setMaterialInspectionPropertyWithFamily,
    setMaterialInspectionTextureWithFamily,
} from "../../../packages/babylon-lite/src/inspection/material-inspection";
import { nodeMaterialInspectionDescriptor } from "../../../packages/babylon-lite/src/inspection/node-material-inspection";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import type { NodeInputHandle, NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { Texture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";

function inspect(material: NodeMaterial) {
    return inspectMaterialWithFamily(material, nodeMaterialInspectionDescriptor);
}

async function setProperty(material: NodeMaterial, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue) {
    return setMaterialInspectionPropertyWithFamily({ scenes: [] }, material, id, value, nodeMaterialInspectionDescriptor);
}

async function setTexture(
    scope: MaterialInspectionMutationScope,
    material: Material,
    id: MaterialTextureBindingId,
    mutation: { readonly direction: "assign" | "replace"; readonly texture: object } | { readonly direction: "clear" }
) {
    return setMaterialInspectionTextureWithFamily(scope, material, id, mutation, nodeMaterialInspectionDescriptor);
}

function valueHandle(type: Exclude<NodeInputHandle["type"], "texture2d">, initial: number | number[], onSet?: () => void): NodeInputHandle {
    let current = Array.isArray(initial) ? initial.slice() : initial;
    return {
        type,
        get value(): number | number[] {
            return Array.isArray(current) ? current.slice() : current;
        },
        set value(value: number | number[]) {
            current = Array.isArray(value) ? value.slice() : value;
            onSet?.();
        },
    };
}

function textureHandle(initial: Texture2D | null, onSet?: () => void): NodeInputHandle {
    let current = initial;
    return {
        type: "texture2d",
        get texture(): Texture2D | null {
            return current;
        },
        set texture(value: Texture2D | null) {
            current = value;
            onSet?.();
        },
    };
}

function createNodeMaterial(inputs: Record<string, NodeInputHandle>): NodeMaterial {
    const buildGroup = Object.assign(vi.fn(), { _materialFamily: "node" as const });
    return {
        name: "Nodes",
        inputs,
        _buildGroup: buildGroup,
        _uboVersion: 0,
        _uboDirty: false,
        _renderFeatures: { features: 0 },
        _graph: { private: "graph-state" },
        _vertexBody: "private vertex WGSL",
        _fragmentBody: "private fragment WGSL",
    } as unknown as NodeMaterial;
}

function texture2d(seed: number, sampleType: "float" | "depth" = "float"): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 16,
        height: 8,
        _sampleType: sampleType,
    };
}

function texture2dArray(seed: number): Texture2DArray {
    return {
        ...texture2d(seed),
        layers: 2,
    };
}

function createScene(materials: readonly Material[]): { readonly scene: SceneContext; readonly rebuild: ReturnType<typeof vi.fn> } {
    const meshes = materials.map((material) => ({ material }) as Mesh);
    const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh) => ({ mesh, order: 0, isTransparent: false }) as Renderable);
    const scene = {
        surface: { engine: { _retirements: [] } },
        meshes,
        _groups: new Map([
            [
                materials[0]!._buildGroup,
                Object.assign(
                    meshes.filter((mesh) => mesh.material?._buildGroup === materials[0]!._buildGroup),
                    { r: rebuild }
                ),
            ],
        ]),
        _renderables: [],
        _meshDisposables: new Map(),
        _renderableVersion: 0,
        _materialEpoch: 0,
        _frameGraph: { build: vi.fn() },
    } as unknown as SceneContext;
    return { scene, rebuild };
}

describe("Node material inspection matrix", () => {
    it("sorts public input keys deterministically and maps every supported value type to copied controls", () => {
        const material = createNodeMaterial({
            vector4: valueHandle("vec4f", [7, 8, 9, 10]),
            scalar: valueHandle("f32", 0.5),
            vector3: valueHandle("vec3f", [4, 5, 6]),
            vector2: valueHandle("vec2f", [2, 3]),
        });

        const snapshot = inspect(material);
        expect(snapshot.family).toBe("node");
        expect(
            snapshot.properties.map((property) => [
                property.id,
                property.label,
                property.valueType,
                property.value.state === "present" ? property.value.value : property.value.state,
                property.access,
            ])
        ).toEqual([
            ["material.name", "Name", "string", "Nodes", { access: "read-write", mutation: "A", postMutation: "none" }],
            ["node.input:scalar", "scalar", "number", 0.5, { access: "read-write", mutation: "A", postMutation: "none", number: { finite: true } }],
            ["node.input:vector2", "vector2", "vec2", [2, 3], { access: "read-write", mutation: "A", postMutation: "none", number: undefined }],
            ["node.input:vector3", "vector3", "vec3", [4, 5, 6], { access: "read-write", mutation: "A", postMutation: "none", number: undefined }],
            ["node.input:vector4", "vector4", "vec4", [7, 8, 9, 10], { access: "read-write", mutation: "A", postMutation: "none", number: undefined }],
        ]);

        const vector = snapshot.properties.find(({ id }) => id === "node.input:vector3")!.value;
        if (vector.state === "present" && Array.isArray(vector.value)) {
            (vector.value as number[])[0] = 99;
        }
        expect(inspect(material).properties.find(({ id }) => id === "node.input:vector3")!.value).toEqual({ state: "present", value: [4, 5, 6] });
    });

    it("reports nullable texture inputs in deterministic order with safe directions and exact-object navigation", () => {
        const selected = texture2d(1);
        const material = createNodeMaterial({
            zTexture: textureHandle(null),
            value: valueHandle("f32", 1),
            aTexture: textureHandle(selected),
        });

        const bindings = inspect(material).textureBindings;
        expect(bindings.map(({ id, label, acceptedKinds, sampleCategory, viewCategory }) => [id, label, acceptedKinds, sampleCategory, viewCategory])).toEqual([
            ["node.texture:aTexture", "aTexture", ["2d"], "float", "2d"],
            ["node.texture:zTexture", "zTexture", ["2d"], "float", "2d"],
        ]);
        expect(bindings.map(({ value }) => value)).toEqual([{ state: "present", value: { entity: selected, kind: "2d" } }, { state: "absent" }]);
        expect(bindings.map(({ directions }) => directions)).toEqual([["replace", "clear", "navigate"], ["assign"]]);
        expect(bindings.map(({ mutation }) => mutation)).toEqual([
            { access: "read-write", mutation: "R", postMutation: "rebuild-material" },
            { access: "read-write", mutation: "R", postMutation: "rebuild-material" },
        ]);
    });

    it("uses only public handles and omits graph, shader, editor, and private runtime state", () => {
        const material = createNodeMaterial({
            visible: valueHandle("f32", 2),
            albedo: textureHandle(texture2d(1)),
        });
        const snapshot = inspect(material);
        const serializedInspectionFields = JSON.stringify({
            properties: snapshot.properties,
            textureBindings: snapshot.textureBindings,
        });

        expect(snapshot.source).toBe(material);
        expect(serializedInspectionFields).not.toContain("graph-state");
        expect(serializedInspectionFields).not.toContain("WGSL");
        expect(serializedInspectionFields).not.toMatch(/editor|_graph|_compile|_uniformValues|_textureSlots/i);

        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/inspection/node-material-inspection.ts"), "utf-8");
        expect(source).not.toMatch(/_graph|_compile|_uniformValues|_textureSlots|source-editor|register/i);
        expect(source).not.toMatch(/\bnew (?:Map|Set|WeakMap)\s*\(/);
    });
});

describe("Node material parameter mutation", () => {
    it("routes scalar and tuple edits through A-owned public value setters", async () => {
        const scalarSet = vi.fn();
        const vectorSet = vi.fn();
        const material = createNodeMaterial({
            scalar: valueHandle("f32", 1, scalarSet),
            vector: valueHandle("vec3f", [1, 2, 3], vectorSet),
        });

        await expect(setProperty(material, "node.input:scalar", 2)).resolves.toEqual({
            changed: true,
            mutation: "A",
            postMutation: "none",
        });
        await expect(setProperty(material, "node.input:vector", [4, 5, 6])).resolves.toEqual({
            changed: true,
            mutation: "A",
            postMutation: "none",
        });
        expect(scalarSet).toHaveBeenCalledOnce();
        expect(vectorSet).toHaveBeenCalledOnce();
        expect(material._uboVersion).toBe(0);
        expect(inspect(material).properties.find(({ id }) => id === "node.input:vector")!.value).toEqual({ state: "present", value: [4, 5, 6] });
    });

    it("rejects invalid and stale edits before invoking a handle setter and treats equal values as no-ops", async () => {
        const scalarSet = vi.fn();
        const vectorSet = vi.fn();
        const material = createNodeMaterial({
            scalar: valueHandle("f32", 1, scalarSet),
            vector: valueHandle("vec2f", [2, 3], vectorSet),
        });

        await expect(setProperty(material, "node.input:scalar", Number.NaN)).rejects.toThrow(/finite/);
        await expect(setProperty(material, "node.input:vector", [1, 2, 3])).rejects.toThrow(/2-component/);
        await expect(setProperty(material, "node.input:missing", 1)).rejects.toThrow(/stale|unsupported/);
        await expect(setProperty(material, "node.input:scalar", 1)).resolves.toEqual({
            changed: false,
            mutation: "A",
            postMutation: "none",
        });
        expect(scalarSet).not.toHaveBeenCalled();
        expect(vectorSet).not.toHaveBeenCalled();
    });
});

describe("Node material texture mutation", () => {
    it("assigns, replaces, and clears through the public texture handle and rebuilds every owning source/view", async () => {
        const textureSet = vi.fn();
        const material = createNodeMaterial({ albedo: textureHandle(null, textureSet) });
        const view = createMaterialView(material, { features: 1 }) as MaterialView;
        const firstScene = createScene([material, view]);
        const secondScene = createScene([material]);
        const scope = { scenes: [firstScene.scene, secondScene.scene, firstScene.scene] };
        const first = texture2d(1);
        const second = texture2d(2);

        await expect(setTexture(scope, material, "node.texture:albedo", { direction: "assign", texture: first })).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(inspect(material).textureBindings[0]!.value).toEqual({ state: "present", value: { entity: first, kind: "2d" } });
        expect(firstScene.rebuild).toHaveBeenCalledTimes(2);
        expect(secondScene.rebuild).toHaveBeenCalledOnce();

        await expect(setTexture(scope, view, "node.texture:albedo", { direction: "replace", texture: second })).resolves.toMatchObject({ changed: true, mutation: "R" });
        await expect(setTexture(scope, material, "node.texture:albedo", { direction: "clear" })).resolves.toMatchObject({ changed: true, mutation: "R" });
        expect(inspect(material).textureBindings[0]!.value).toEqual({ state: "absent" });
        expect(textureSet).toHaveBeenCalledTimes(3);
    });

    it("rejects incompatible, unsupported-direction, and stale assignments without changing the old texture", async () => {
        const textureSet = vi.fn();
        const original = texture2d(1);
        const material = createNodeMaterial({ albedo: textureHandle(original, textureSet), empty: textureHandle(null, textureSet) });
        const { scene, rebuild } = createScene([material]);
        const invalid = [texture2d(2, "depth"), texture2dArray(3), { width: 1, height: 1 }];

        for (const texture of invalid) {
            await expect(setTexture({ scenes: [scene] }, material, "node.texture:albedo", { direction: "replace", texture })).rejects.toThrow(/Texture2D/);
        }
        await expect(setTexture({ scenes: [scene] }, material, "node.texture:albedo", { direction: "assign", texture: texture2d(4) })).rejects.toThrow(/does not support "assign"/);
        await expect(setTexture({ scenes: [scene] }, material, "node.texture:empty", { direction: "clear" })).rejects.toThrow(/does not support "clear"/);
        await expect(setTexture({ scenes: [scene] }, material, "node.texture:missing", { direction: "replace", texture: texture2d(5) })).rejects.toThrow(/stale|unsupported/);
        expect(textureSet).not.toHaveBeenCalled();
        expect(rebuild).not.toHaveBeenCalled();
        expect(inspect(material).textureBindings.find(({ id }) => id === "node.texture:albedo")!.value).toEqual({
            state: "present",
            value: { entity: original, kind: "2d" },
        });
    });

    it("treats repeated texture replacement as a no-op without rebuilding", async () => {
        const textureSet = vi.fn();
        const original = texture2d(1);
        const material = createNodeMaterial({ albedo: textureHandle(original, textureSet) });
        const { scene, rebuild } = createScene([material]);

        await expect(setTexture({ scenes: [scene] }, material, "node.texture:albedo", { direction: "replace", texture: original })).resolves.toEqual({
            changed: false,
            mutation: "R",
            postMutation: "none",
        });
        expect(textureSet).not.toHaveBeenCalled();
        expect(rebuild).not.toHaveBeenCalled();
    });
});
