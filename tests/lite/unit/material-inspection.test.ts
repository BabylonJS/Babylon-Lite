import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
    getMaterialTextureBindings,
    inspectMaterial,
    setMaterialInspectionProperty,
    setMaterialInspectionTexture,
    type InspectionDatum,
    type InspectionValue,
    type Material,
    type MaterialInspection,
    type MaterialInspectionMutationScope,
    type MaterialInspectionProperty,
    type MaterialInspectionPropertyValue,
    type MaterialTextureBinding,
} from "../../../packages/babylon-lite/src";
import {
    inspectMaterialWithFamily,
    setMaterialInspectionPropertyWithFamily,
    setMaterialInspectionTextureWithFamily,
    type MaterialInspectionFamilyDescriptor,
    type MaterialInspectionMutationPlan,
} from "../../../packages/babylon-lite/src/inspection/material-inspection";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function readInspectionValue(value: InspectionValue<MaterialInspectionPropertyValue>): MaterialInspectionPropertyValue | string {
    switch (value.state) {
        case "present":
            return value.value;
        case "absent":
            return "absent";
        case "unsupported":
            return value.reason;
    }
}

function readInspectionDatum(value: InspectionDatum<number>): number | string {
    return value.state === "known" ? value.value : (value.reason ?? "unknown");
}

describe("inspection value contracts", () => {
    it("distinguishes present values from absent and unsupported states without truthiness", () => {
        const zero = { state: "present", value: 0 } as const satisfies InspectionValue<MaterialInspectionPropertyValue>;
        const disabled = { state: "present", value: false } as const satisfies InspectionValue<MaterialInspectionPropertyValue>;
        const empty = { state: "present", value: "" } as const satisfies InspectionValue<MaterialInspectionPropertyValue>;
        const absent = { state: "absent" } as const satisfies InspectionValue<MaterialInspectionPropertyValue>;
        const unsupported = { state: "unsupported", reason: "No public setter" } as const satisfies InspectionValue<MaterialInspectionPropertyValue>;

        expect([readInspectionValue(zero), readInspectionValue(disabled), readInspectionValue(empty)]).toEqual([0, false, ""]);
        expect(readInspectionValue(absent)).toBe("absent");
        expect(readInspectionValue(unsupported)).toBe("No public setter");
    });

    it("distinguishes known metadata from unknown metadata", () => {
        const known = { state: "known", value: 0 } as const satisfies InspectionDatum<number>;
        const unknown = { state: "unknown" } as const satisfies InspectionDatum<number>;
        const unknownWithReason = { state: "unknown", reason: "Sampler descriptor is not retained" } as const satisfies InspectionDatum<number>;

        expect(readInspectionDatum(known)).toBe(0);
        expect(readInspectionDatum(unknown)).toBe("unknown");
        expect(readInspectionDatum(unknownWithReason)).toBe("Sampler descriptor is not retained");
    });
});

describe("unknown material family contract", () => {
    it("represents identity-only inspection without speculative properties or bindings", () => {
        const source = { name: "Future Material" } as Material;
        const inspection = {
            source,
            family: undefined,
            displayName: "Future Material",
            isView: false,
            properties: [],
            textureBindings: [],
        } as const satisfies MaterialInspection;

        expect(inspection).toEqual({
            source,
            family: undefined,
            displayName: "Future Material",
            isView: false,
            properties: [],
            textureBindings: [],
        });
        expectTypeOf<MaterialInspection["family"]>().toEqualTypeOf<string | undefined>();
        expectTypeOf<MaterialInspection["properties"]>().toEqualTypeOf<readonly MaterialInspection["properties"][number][]>();
        expectTypeOf<MaterialInspection["textureBindings"]>().toEqualTypeOf<readonly MaterialInspection["textureBindings"][number][]>();
    });
});

function createMaterial(family?: string, name?: unknown): Material & { amount?: number; vector?: number[] } {
    const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh) => ({ mesh, order: 0, isTransparent: false }) as Renderable);
    const builder = Object.assign(vi.fn(), { _materialFamily: family, _rebuildSingle: rebuild }) as unknown as MeshGroupBuilder;
    return { _buildGroup: builder, _uboVersion: 0, name } as unknown as Material & { amount?: number; vector?: number[] };
}

function createScene(materials: readonly Material[]): {
    readonly scene: SceneContext;
    readonly rebuild: ReturnType<typeof vi.fn>;
    readonly frameGraphBuild: ReturnType<typeof vi.fn>;
} {
    const meshes = materials.map((material) => ({ material }) as Mesh);
    const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh) => ({ mesh, order: 0, isTransparent: false }) as Renderable);
    const frameGraphBuild = vi.fn();
    const scene = {
        surface: { engine: { _retirements: [] } },
        meshes,
        _groups: new Map(),
        _renderables: [],
        _meshDisposables: new Map(),
        _renderableVersion: 0,
        _materialEpoch: 0,
        _frameGraph: { build: frameGraphBuild },
    } as unknown as SceneContext;
    const builder = materials[0]?._buildGroup;
    if (builder) {
        scene._groups.set(builder, Object.assign(meshes.slice(), { r: rebuild }));
    }
    return { scene, rebuild, frameGraphBuild };
}

function property(
    id: MaterialInspectionProperty["id"],
    valueType: MaterialInspectionProperty["valueType"],
    value: MaterialInspectionPropertyValue,
    mutation: "U" | "R" | "A" | "U/R" = "A",
    postMutation: "none" | "rebuild-material" | "rebuild-material-and-frame-graph" = "none"
): MaterialInspectionProperty {
    return {
        id,
        section: "inputs",
        label: id,
        valueType,
        value: { state: "present", value },
        access: { access: "read-write", mutation, postMutation },
    };
}

function binding(entity: object): MaterialTextureBinding {
    return {
        id: "shader.sampler:color",
        label: "Color",
        value: { state: "present", value: { entity, kind: "2d" } },
        acceptedKinds: ["2d"],
        sampleCategory: "float",
        viewCategory: "2d",
        directions: ["replace", "clear", "navigate"],
        mutation: { access: "read-write", mutation: "R", postMutation: "rebuild-material" },
        transform: { state: "unsupported", reason: "Shader textures do not use the standard transform." },
    };
}

describe("common material inspection", () => {
    it("uses stable identity fallbacks, unwraps views, and safely handles malformed inputs", () => {
        const standard = createMaterial("standard");
        const unknown = createMaterial("future");
        const named = createMaterial("pbr", "Named");
        const view = createMaterialView(standard, { features: 1 });

        expect(inspectMaterial(standard)).toMatchObject({
            source: standard,
            family: "standard",
            displayName: "Standard Material",
            isView: false,
            textureBindings: [],
        });
        expect(inspectMaterial(unknown)).toMatchObject({
            source: unknown,
            family: "future",
            displayName: "Material",
            isView: false,
            textureBindings: [],
        });
        expect(inspectMaterial(named).displayName).toBe("Named");
        expect(inspectMaterial(view)).toMatchObject({
            source: standard,
            family: "standard",
            displayName: "Standard Material",
            isView: true,
        });
        expect(getMaterialTextureBindings(view)).toEqual([]);

        expect(inspectMaterial(null as unknown as Material)).toEqual({
            source: null,
            family: undefined,
            displayName: "Material",
            isView: false,
            properties: [],
            textureBindings: [],
        });
        expect(inspectMaterial({ name: 42, _buildGroup: null } as unknown as Material)).toMatchObject({
            family: undefined,
            displayName: "Material",
            properties: [{ id: "material.name", value: { state: "unsupported" } }],
            textureBindings: [],
        });
    });

    it("falls back to identity-only inspection when a family translator rejects malformed state", () => {
        const source = createMaterial("standard");
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: () => {
                throw new Error("malformed");
            },
        };

        const inspection = inspectMaterialWithFamily(source, descriptor);

        expect(inspection.properties.map(({ id }) => id)).toEqual(["material.name"]);
        expect(inspection.textureBindings).toEqual([]);
    });

    it("copies tuple values and mutation candidates", async () => {
        const source = createMaterial("node");
        const live = [1, 2, 3];
        source.vector = live;
        let received: MaterialInspectionPropertyValue | undefined;
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: (material) => ({
                properties: [property("node.input:vector", "vec3", (material as typeof source).vector as [number, number, number])],
                textureBindings: [],
            }),
            preparePropertyMutation: (_material, _property, value) => {
                received = value;
                return {
                    mutation: "A",
                    apply: () => {
                        source.vector = [...(value as readonly number[])];
                    },
                };
            },
        };

        const inspection = inspectMaterialWithFamily(source, descriptor);
        const inspected = inspection.properties[1]!.value;
        expect(inspected.state).toBe("present");
        expect(inspected.state === "present" ? inspected.value : undefined).toEqual([1, 2, 3]);
        expect(inspected.state === "present" ? inspected.value : undefined).not.toBe(live);
        live[0] = 9;
        expect(inspected.state === "present" ? inspected.value : undefined).toEqual([1, 2, 3]);

        const candidate = [4, 5, 6] as [number, number, number];
        await setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "node.input:vector", candidate, descriptor);
        expect(received).toEqual(candidate);
        expect(received).not.toBe(candidate);
        expect(source.vector).toEqual(candidate);
    });
});

describe("common material mutation validation", () => {
    it("validates finite, range, integer, enum, scalar type, and tuple shape before preparing a write", async () => {
        const source = createMaterial("shader");
        source.amount = 2;
        source.vector = [1, 2, 3];
        const prepare = vi.fn<NonNullable<MaterialInspectionFamilyDescriptor["preparePropertyMutation"]>>(() => ({
            mutation: "U",
            apply: vi.fn(),
        }));
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: (material) => ({
                properties: [
                    {
                        ...property("shader.uniform:count", "number", (material as typeof source).amount ?? 0, "U"),
                        access: {
                            access: "read-write",
                            mutation: "U",
                            postMutation: "none",
                            number: { finite: true, integer: true, min: 0, max: 10 },
                        },
                    },
                    {
                        ...property("shader.uniform:mode", "enum", 0, "U"),
                        options: [
                            { value: 0, label: "Zero" },
                            { value: 1, label: "One" },
                        ],
                    },
                    property("shader.uniform:vector", "vec3", (material as typeof source).vector as [number, number, number], "U"),
                ],
                textureBindings: [],
            }),
            preparePropertyMutation: prepare,
        };
        const scope: MaterialInspectionMutationScope = { scenes: [] };
        const invalid: readonly [MaterialInspectionProperty["id"], unknown, RegExp][] = [
            ["shader.uniform:count", Number.NaN, /finite/],
            ["shader.uniform:count", Number.POSITIVE_INFINITY, /finite/],
            ["shader.uniform:count", -1, /at least/],
            ["shader.uniform:count", 11, /at most/],
            ["shader.uniform:count", 1.5, /integer/],
            ["shader.uniform:count", "2", /finite number/],
            ["shader.uniform:mode", 2, /enum value/],
            ["shader.uniform:mode", false, /enum value/],
            ["shader.uniform:vector", [1, 2], /3-component/],
            ["shader.uniform:vector", [1, 2, Number.NaN], /finite tuple/],
            ["shader.uniform:vector", "1,2,3", /3-component/],
        ];

        for (const [id, value, message] of invalid) {
            await expect(setMaterialInspectionPropertyWithFamily(scope, source, id, value as MaterialInspectionPropertyValue, descriptor)).rejects.toThrow(message);
        }

        expect(prepare).not.toHaveBeenCalled();
        expect(source.amount).toBe(2);
        expect(source.vector).toEqual([1, 2, 3]);
        expect(source._uboVersion).toBe(0);
    });

    it("rejects stale property and binding IDs without changing the source", async () => {
        const source = createMaterial("future", "Old");

        await expect(setMaterialInspectionProperty({ scenes: [] }, source, "standard.alpha", 0.5)).rejects.toThrow(/stale or unsupported/);
        await expect(setMaterialInspectionTexture({ scenes: [] }, source, "standard.diffuse", { direction: "clear" })).rejects.toThrow(/stale or unsupported/);

        expect(source.name).toBe("Old");
        expect(source._uboVersion).toBe(0);
    });

    it("rejects invalid binding directions and values before family mutation", async () => {
        const source = createMaterial("shader");
        const current = {};
        const prepare = vi.fn<NonNullable<MaterialInspectionFamilyDescriptor["prepareTextureMutation"]>>(() => ({
            mutation: "R",
            apply: vi.fn(),
        }));
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: () => ({ properties: [], textureBindings: [binding(current)] }),
            prepareTextureMutation: prepare,
        };

        await expect(setMaterialInspectionTextureWithFamily({ scenes: [] }, source, "shader.sampler:color", { direction: "assign", texture: {} }, descriptor)).rejects.toThrow(
            /does not support/
        );
        await expect(
            setMaterialInspectionTextureWithFamily({ scenes: [] }, source, "shader.sampler:color", { direction: "replace", texture: null as unknown as object }, descriptor)
        ).rejects.toThrow(/texture object/);

        expect(prepare).not.toHaveBeenCalled();
    });

    it("treats identical property and binding commits as no-ops", async () => {
        const source = createMaterial("shader");
        source.amount = 2;
        const texture = {};
        const prepareProperty = vi.fn<NonNullable<MaterialInspectionFamilyDescriptor["preparePropertyMutation"]>>();
        const prepareTexture = vi.fn<NonNullable<MaterialInspectionFamilyDescriptor["prepareTextureMutation"]>>();
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: (material) => ({
                properties: [property("shader.uniform:amount", "number", (material as typeof source).amount ?? 0, "U/R", "rebuild-material")],
                textureBindings: [binding(texture)],
            }),
            preparePropertyMutation: prepareProperty,
            prepareTextureMutation: prepareTexture,
        };

        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "shader.uniform:amount", 2, descriptor)).resolves.toEqual({
            changed: false,
            mutation: "U",
            postMutation: "none",
        });
        await expect(setMaterialInspectionTextureWithFamily({ scenes: [] }, source, "shader.sampler:color", { direction: "replace", texture }, descriptor)).resolves.toEqual({
            changed: false,
            mutation: "R",
            postMutation: "none",
        });

        expect(prepareProperty).not.toHaveBeenCalled();
        expect(prepareTexture).not.toHaveBeenCalled();
        expect(source._uboVersion).toBe(0);
    });
});

describe("common material mutation execution", () => {
    it("edits material.name as A with no renderer invalidation", async () => {
        const source = createMaterial("standard", "Old");
        source._uboVersion = 7;
        const view = createMaterialView(source, { features: 1 });
        const { scene, rebuild, frameGraphBuild } = createScene([source, view]);

        await expect(setMaterialInspectionProperty({ scenes: [scene] }, view, "material.name", "")).resolves.toEqual({
            changed: true,
            mutation: "A",
            postMutation: "none",
        });
        await expect(setMaterialInspectionProperty({ scenes: [] }, source, "material.name", "")).resolves.toEqual({
            changed: false,
            mutation: "A",
            postMutation: "none",
        });

        expect(source.name).toBe("");
        expect(source._uboVersion).toBe(7);
        expect(rebuild).not.toHaveBeenCalled();
        expect(frameGraphBuild).not.toHaveBeenCalled();
    });

    it("marks U mutations exactly once unless the public setter owns invalidation", async () => {
        const source = createMaterial("shader");
        source.amount = 1;
        source._uboVersion = 4;
        const descriptor = (invalidationOwned: boolean): MaterialInspectionFamilyDescriptor => ({
            inspect: (material) => ({
                properties: [property("shader.uniform:amount", "number", (material as typeof source).amount ?? 0, "U")],
                textureBindings: [],
            }),
            preparePropertyMutation: (_material, _property, value) => ({
                mutation: "U",
                invalidationOwned,
                apply: () => {
                    source.amount = value as number;
                    if (invalidationOwned) {
                        source._uboVersion++;
                    }
                },
            }),
        });

        await setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "shader.uniform:amount", 2, descriptor(false));
        expect(source._uboVersion).toBe(5);
        await setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "shader.uniform:amount", 3, descriptor(true));
        expect(source._uboVersion).toBe(6);
    });

    it("deduplicates owning scenes, rebuilds source views, and rebuilds the frame graph only for changed participation", async () => {
        const source = createMaterial("standard");
        source.amount = 1;
        const view = createMaterialView(source, { features: 1 });
        const { scene, rebuild, frameGraphBuild } = createScene([source, view]);
        const descriptor = (frameGraphParticipationChanged: boolean): MaterialInspectionFamilyDescriptor => ({
            inspect: (material) => ({
                properties: [
                    property(
                        "standard.alpha",
                        "number",
                        (material as typeof source).amount ?? 0,
                        "R",
                        frameGraphParticipationChanged ? "rebuild-material-and-frame-graph" : "rebuild-material"
                    ),
                ],
                textureBindings: [],
            }),
            preparePropertyMutation: (_material, _property, value): MaterialInspectionMutationPlan => ({
                mutation: "R",
                frameGraphParticipationChanged,
                apply: () => {
                    source.amount = value as number;
                },
            }),
        });

        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [scene, scene] }, view, "standard.alpha", 2, descriptor(false))).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(rebuild).toHaveBeenCalledTimes(2);
        expect(frameGraphBuild).not.toHaveBeenCalled();

        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [scene] }, source, "standard.alpha", 3, descriptor(true))).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material-and-frame-graph",
        });
        expect(rebuild).toHaveBeenCalledTimes(4);
        expect(frameGraphBuild).toHaveBeenCalledOnce();
    });

    it("rejects missing or incorrect scene ownership before writing", async () => {
        const source = createMaterial("standard");
        source.amount = 1;
        const apply = vi.fn(() => {
            source.amount = 2;
        });
        const descriptor: MaterialInspectionFamilyDescriptor = {
            inspect: (material) => ({
                properties: [property("standard.alpha", "number", (material as typeof source).amount ?? 0, "R", "rebuild-material")],
                textureBindings: [],
            }),
            preparePropertyMutation: () => ({ mutation: "R", apply }),
        };
        const unrelated = createMaterial("standard");
        const { scene } = createScene([unrelated]);

        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "standard.alpha", 2, descriptor)).rejects.toThrow(/owning scene/);
        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [scene] }, source, "standard.alpha", 2, descriptor)).rejects.toThrow(/not reachable/);

        expect(apply).not.toHaveBeenCalled();
        expect(source.amount).toBe(1);
    });

    it("preserves the old value when preparation or the public mutation step rejects", async () => {
        const source = createMaterial("shader");
        source.amount = 1;
        const inspection = (material: Material) => ({
            properties: [property("shader.uniform:amount", "number", (material as typeof source).amount ?? 0, "A")],
            textureBindings: [],
        });
        const prepareFailure: MaterialInspectionFamilyDescriptor = {
            inspect: inspection,
            preparePropertyMutation: () => {
                throw new Error("prepare failed");
            },
        };
        const setterFailure: MaterialInspectionFamilyDescriptor = {
            inspect: inspection,
            preparePropertyMutation: () => ({
                mutation: "A",
                apply: () => {
                    throw new Error("setter failed");
                },
            }),
        };

        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "shader.uniform:amount", 2, prepareFailure)).rejects.toThrow("prepare failed");
        expect(source.amount).toBe(1);
        await expect(setMaterialInspectionPropertyWithFamily({ scenes: [] }, source, "shader.uniform:amount", 2, setterFailure)).rejects.toThrow("setter failed");
        expect(source.amount).toBe(1);
        expect(source._uboVersion).toBe(0);
    });
});
