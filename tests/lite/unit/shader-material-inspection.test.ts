import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
import { shaderMaterialInspectionDescriptor } from "../../../packages/babylon-lite/src/inspection/shader-material-inspection";
import { createShaderMaterial, setShaderTexture, type ShaderMaterial, type ShaderMaterialOptions } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { Texture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";

const VERTEX = wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`;
const FRAGMENT = wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`;
const SCOPE: MaterialInspectionMutationScope = { scenes: [] };

function createShader(options: Partial<Omit<ShaderMaterialOptions, "vertexSource" | "fragmentSource" | "attributes">> = {}): ShaderMaterial {
    return createShaderMaterial({
        vertexSource: VERTEX,
        fragmentSource: FRAGMENT,
        attributes: ["position"],
        ...options,
    });
}

function inspect(material: ShaderMaterial) {
    return inspectMaterialWithFamily(material, shaderMaterialInspectionDescriptor);
}

function propertyValues(material: ShaderMaterial): Record<string, MaterialInspectionPropertyValue | string> {
    return Object.fromEntries(
        inspect(material).properties.map((property) => [
            property.id,
            property.value.state === "present" ? property.value.value : property.value.state === "absent" ? "absent" : property.value.reason,
        ])
    );
}

async function setProperty(material: ShaderMaterial, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue) {
    return setMaterialInspectionPropertyWithFamily(SCOPE, material, id, value, shaderMaterialInspectionDescriptor);
}

async function setTexture(
    material: ShaderMaterial,
    id: MaterialTextureBindingId,
    mutation: { readonly direction: "assign" | "replace"; readonly texture: object } | { readonly direction: "clear" }
) {
    return setMaterialInspectionTextureWithFamily(SCOPE, material, id, mutation, shaderMaterialInspectionDescriptor);
}

function texture2d(seed: number, sampleType: "float" | "depth" = "float"): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 8,
        height: 4,
        _sampleType: sampleType,
    };
}

function texture2dArray(seed: number, sampleType: "float" | "depth" = "float"): Texture2DArray {
    return {
        ...texture2d(seed, sampleType),
        layers: 3,
    };
}

describe("Shader material inspection matrix", () => {
    it("emits every declared custom uniform in declaration order with exact controls and copied tuples", () => {
        const matrix = Array.from({ length: 16 }, (_, index) => index + 1);
        const material = createShader({
            uniforms: [
                { name: "scalar", type: "f32", defaultValue: 0.5 },
                "world",
                { name: "unsignedCount", type: "u32", defaultValue: 2 },
                { name: "signedCount", type: "i32", defaultValue: -3 },
                "screenSize",
                { name: "uv", type: "vec2<f32>", defaultValue: [1, 2] },
                { name: "direction", type: "vec3<f32>", defaultValue: [3, 4, 5] },
                { name: "color", type: "vec4<f32>", defaultValue: [6, 7, 8, 9] },
                { name: "transform", type: "mat4x4<f32>", defaultValue: matrix },
            ],
        });

        const snapshot = inspect(material);
        expect(snapshot.family).toBe("shader");
        const properties = snapshot.properties;
        const uniformProperties = properties.filter(({ id }) => id.startsWith("shader.uniform:"));
        expect(uniformProperties.map(({ id, section, valueType }) => [id, section, valueType])).toEqual([
            ["shader.uniform:scalar", "inputs", "number"],
            ["shader.uniform:unsignedCount", "inputs", "number"],
            ["shader.uniform:signedCount", "inputs", "number"],
            ["shader.uniform:uv", "inputs", "vec2"],
            ["shader.uniform:direction", "inputs", "vec3"],
            ["shader.uniform:color", "inputs", "vec4"],
            ["shader.uniform:transform", "inputs", "mat4"],
        ]);
        expect(propertyValues(material)).toMatchObject({
            "shader.uniform:scalar": 0.5,
            "shader.uniform:unsignedCount": 2,
            "shader.uniform:signedCount": -3,
            "shader.uniform:uv": [1, 2],
            "shader.uniform:direction": [3, 4, 5],
            "shader.uniform:color": [6, 7, 8, 9],
            "shader.uniform:transform": matrix,
        });

        const byId = new Map(properties.map((property) => [property.id, property]));
        expect(byId.get("shader.uniform:scalar")?.access).toEqual({
            access: "read-write",
            mutation: "A",
            postMutation: "none",
            number: { finite: true },
        });
        expect(byId.get("shader.uniform:unsignedCount")?.access).toMatchObject({
            number: { finite: true, integer: true, min: 0, max: 0xffffffff },
        });
        expect(byId.get("shader.uniform:signedCount")?.access).toMatchObject({
            number: { finite: true, integer: true, min: -0x80000000, max: 0x7fffffff },
        });
        expect(byId.get("shader.uniform:uv")?.access).toEqual({
            access: "read-write",
            mutation: "A",
            postMutation: "none",
            number: undefined,
        });

        const uv = byId.get("shader.uniform:uv")!.value;
        expect(uv.state).toBe("present");
        if (uv.state === "present") {
            expect(uv.value).not.toBe(material._uniformValues.get("uv")!.value);
        }
        const transform = byId.get("shader.uniform:transform")!.value;
        expect(transform.state).toBe("present");
        if (transform.state === "present") {
            expect(transform.value).not.toBe(material._uniformValues.get("transform")!.value);
        }
    });

    it("reports the approved pipeline configuration read-only without source, system values, or storage values", async () => {
        const storageValue = { sentinel: "bound-storage-value" };
        const material = createShader({
            name: "Configured",
            uniforms: ["world", { name: "amount", type: "f32" }],
            storageBuffers: [{ name: "particles", type: "array<vec4<f32>>" }],
            defines: { ENABLED: true, COUNT: 2 },
            blend: {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                alpha: { srcFactor: "one", dstFactor: "zero", operation: "subtract" },
            },
            transmissive: true,
            needAlphaBlending: true,
            needAlphaTesting: true,
            backFaceCulling: false,
            depthWrite: false,
            depthCompare: "greater",
            depthOnlyFragment: true,
            depthBias: 2,
            depthBiasSlopeScale: 3,
            topology: "line-list",
        });
        material._uniformValues.get("world")!.value[0] = 12345;
        material._storageBufferSlots.get("particles")!.current = storageValue as never;

        const snapshot = inspect(material);
        const configuration = snapshot.properties.at(-1)!;
        expect(configuration).toMatchObject({
            id: "shader.configuration",
            section: "configuration",
            label: "Configuration",
            valueType: "summary",
            access: { access: "read-only" },
        });
        expect(configuration.value).toEqual({
            state: "present",
            value: "Attributes: position; Defines: COUNT=2, ENABLED=true; Blend: custom color(src-alpha, one-minus-src-alpha, add) alpha(one, zero, subtract); Transmissive: true; Alpha testing: true; Back-face culling: false; Depth write: false; Depth compare: greater; Depth-only fragment: true; Depth bias: 2; Depth bias slope scale: 3; Topology: line-list; Storage buffers: particles: array<vec4<f32>>",
        });
        expect(snapshot.properties.map(({ id }) => id)).not.toContain("shader.uniform:world");
        expect(JSON.stringify(snapshot.properties)).not.toContain("12345");
        expect(JSON.stringify(snapshot.properties)).not.toContain("bound-storage-value");
        expect(JSON.stringify(snapshot.properties)).not.toContain(VERTEX);
        expect(JSON.stringify(snapshot.properties)).not.toContain(FRAGMENT);

        const uniformVersion = material._uniformVersion;
        await expect(setProperty(material, "shader.configuration", "changed")).rejects.toThrow(/read-only|unsupported/i);
        expect(material._uniformVersion).toBe(uniformVersion);
        expect(material.defines).toEqual([
            { name: "COUNT", value: 2 },
            { name: "ENABLED", value: true },
        ]);
    });

    it("emits every sampler in declaration order with declaration-driven kinds, samples, values, and directions", () => {
        const material = createShader({
            samplers: [
                "color",
                { name: "nearest", sampleType: "unfilterable-float" },
                { name: "shadow", sampleType: "float", comparison: true },
                { name: "layers", viewDimension: "2d-array" },
                { name: "depthLayers", sampleType: "depth", viewDimension: "2d-array" },
            ],
        });
        const color = texture2d(1);
        const shadow = texture2d(2, "depth");
        const layers = texture2dArray(3);
        const depthLayers = texture2dArray(4, "depth");
        setShaderTexture(material, "color", color);
        setShaderTexture(material, "shadow", shadow);
        setShaderTexture(material, "layers", layers);
        setShaderTexture(material, "depthLayers", depthLayers);

        const bindings = inspect(material).textureBindings;
        expect(bindings.map(({ id, sampleCategory, viewCategory, acceptedKinds }) => [id, sampleCategory, viewCategory, acceptedKinds])).toEqual([
            ["shader.sampler:color", "float", "2d", ["2d"]],
            ["shader.sampler:nearest", "unfilterable-float", "2d", ["2d"]],
            ["shader.sampler:shadow", "depth", "2d", ["2d"]],
            ["shader.sampler:layers", "float", "2d-array", ["2d-array"]],
            ["shader.sampler:depthLayers", "depth", "2d-array", ["2d-array"]],
        ]);
        expect(bindings.map(({ value }) => value)).toEqual([
            { state: "present", value: { entity: color, kind: "2d" } },
            { state: "absent" },
            { state: "present", value: { entity: shadow, kind: "2d" } },
            { state: "present", value: { entity: layers, kind: "2d-array" } },
            { state: "present", value: { entity: depthLayers, kind: "2d-array" } },
        ]);
        expect(bindings.map(({ directions }) => directions)).toEqual([
            ["replace", "clear", "navigate"],
            ["assign"],
            ["replace", "clear", "navigate"],
            ["replace", "clear", "navigate"],
            ["replace", "clear", "navigate"],
        ]);
        for (const binding of bindings) {
            expect(binding.mutation).toEqual({ access: "read-write", mutation: "A", postMutation: "none", number: undefined });
            expect(binding.transform).toEqual(
                binding.value.state === "present" ? { state: "unsupported", reason: "Shader samplers do not use standard material UV transforms." } : { state: "absent" }
            );
        }
    });

    it("has no registrations, feature fragments, source editors, direct private mutation, or eager collections", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/inspection/shader-material-inspection.ts"), "utf-8");
        expect(source).not.toMatch(/^import .*\/fragments\//m);
        expect(source).not.toMatch(/wgsl|source-editor|register/i);
        expect(source).not.toMatch(/\bnew (?:Map|Set|WeakMap)\s*\(/);
        expect(source).not.toMatch(/_uniformValues\.(?:set|delete|clear)\s*\(/);
        expect(source).not.toMatch(/_textureSlots\.(?:set|delete|clear)\s*\(/);
        expect(source).not.toMatch(/\.current\s*=/);
        expect(source).toMatch(/\bsetShaderUniform\s*\(/);
        expect(source).toMatch(/\bsetShaderTexture\s*\(/);
    });
});

describe("Shader material uniform mutation", () => {
    it("routes every supported uniform through its A-class typed setter path and keeps inspection values isolated", async () => {
        const material = createShader({
            uniforms: [
                { name: "scalar", type: "f32" },
                { name: "unsignedCount", type: "u32" },
                { name: "signedCount", type: "i32" },
                { name: "uv", type: "vec2<f32>" },
                { name: "direction", type: "vec3<f32>" },
                { name: "color", type: "vec4<f32>" },
                { name: "transform", type: "mat4x4<f32>" },
            ],
        });
        const matrix = Array.from({ length: 16 }, (_, index) => index + 1);
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue][] = [
            ["shader.uniform:scalar", 0.5],
            ["shader.uniform:unsignedCount", 42],
            ["shader.uniform:signedCount", -42],
            ["shader.uniform:uv", [1, 2]],
            ["shader.uniform:direction", [3, 4, 5]],
            ["shader.uniform:color", [6, 7, 8, 9]],
            ["shader.uniform:transform", matrix as unknown as MaterialInspectionPropertyValue],
        ];

        for (const [id, value] of mutations) {
            const before = material._uniformVersion;
            await expect(setProperty(material, id, value)).resolves.toEqual({
                changed: true,
                mutation: "A",
                postMutation: "none",
            });
            expect(material._uniformVersion).toBe(before + 1);
            expect(material._uboVersion).toBe(material._uniformVersion);
        }
        expect(propertyValues(material)).toMatchObject(Object.fromEntries(mutations));

        const uvValue = inspect(material).properties.find(({ id }) => id === "shader.uniform:uv")!.value;
        if (uvValue.state === "present" && Array.isArray(uvValue.value)) {
            (uvValue.value as number[])[0] = 999;
        }
        expect(material._uniformValues.get("uv")!.value[0]).toBe(1);
    });

    it("rejects invalid scalar, vector, and matrix edits before invoking the setter", async () => {
        const material = createShader({
            uniforms: [
                { name: "scalar", type: "f32" },
                { name: "unsignedCount", type: "u32" },
                { name: "signedCount", type: "i32" },
                { name: "uv", type: "vec2<f32>" },
                { name: "transform", type: "mat4x4<f32>" },
            ],
        });
        const invalid: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue][] = [
            ["shader.uniform:scalar", Number.NaN],
            ["shader.uniform:unsignedCount", -1],
            ["shader.uniform:unsignedCount", 1.5],
            ["shader.uniform:unsignedCount", 0x1_0000_0000],
            ["shader.uniform:signedCount", -0x8000_0001],
            ["shader.uniform:signedCount", 1.5],
            ["shader.uniform:uv", [1, 2, 3]],
            ["shader.uniform:uv", [1, Number.POSITIVE_INFINITY]],
            ["shader.uniform:transform", Array(15).fill(0) as unknown as MaterialInspectionPropertyValue],
        ];

        for (const [id, value] of invalid) {
            await expect(setProperty(material, id, value)).rejects.toThrow();
        }
        expect(material._uniformVersion).toBe(0);
        expect(material._uboVersion).toBe(0);
    });

    it("treats equal values as no-ops without setter-owned invalidation", async () => {
        const material = createShader({
            uniforms: [
                { name: "scalar", type: "f32", defaultValue: 0.5 },
                { name: "color", type: "vec4<f32>", defaultValue: [1, 2, 3, 4] },
            ],
        });
        const before = material._uniformVersion;

        await expect(setProperty(material, "shader.uniform:scalar", 0.5)).resolves.toEqual({
            changed: false,
            mutation: "A",
            postMutation: "none",
        });
        await expect(setProperty(material, "shader.uniform:color", [1, 2, 3, 4])).resolves.toEqual({
            changed: false,
            mutation: "A",
            postMutation: "none",
        });
        expect(material._uniformVersion).toBe(before);
        expect(material._uboVersion).toBe(before);
    });
});

describe("Shader material texture mutation", () => {
    it("assigns, replaces, and clears compatible 2D, array, unfilterable, and depth textures through A-class setters", async () => {
        const material = createShader({
            samplers: [
                "color",
                { name: "nearest", sampleType: "unfilterable-float" },
                { name: "shadow", sampleType: "depth" },
                { name: "layers", viewDimension: "2d-array" },
                { name: "depthLayers", sampleType: "depth", viewDimension: "2d-array" },
            ],
        });
        const color = texture2d(1);
        const nearest = texture2d(2);
        const shadow = texture2d(3, "depth");
        const layers = texture2dArray(4);
        const depthLayers = texture2dArray(5, "depth");
        const assignments: readonly [MaterialTextureBindingId, object][] = [
            ["shader.sampler:color", color],
            ["shader.sampler:nearest", nearest],
            ["shader.sampler:shadow", shadow],
            ["shader.sampler:layers", layers],
            ["shader.sampler:depthLayers", depthLayers],
        ];

        for (const [id, texture] of assignments) {
            const before = material._resourceVersion;
            await expect(setTexture(material, id, { direction: "assign", texture })).resolves.toEqual({
                changed: true,
                mutation: "A",
                postMutation: "none",
            });
            expect(material._resourceVersion).toBe(before + 1);
        }

        const replacement = texture2d(6);
        await expect(setTexture(material, "shader.sampler:color", { direction: "replace", texture: replacement })).resolves.toMatchObject({
            changed: true,
            mutation: "A",
        });
        expect(material._textureSlots.get("color")!.current).toBe(replacement);
        await expect(setTexture(material, "shader.sampler:color", { direction: "clear" })).resolves.toMatchObject({
            changed: true,
            mutation: "A",
        });
        expect(material._textureSlots.get("color")!.current).toBeNull();
    });

    it("rejects declared view/sample mismatches and setter failures without changing the old selection", async () => {
        const material = createShader({
            samplers: [
                "color",
                { name: "shadow", sampleType: "depth" },
                { name: "layers", viewDimension: "2d-array" },
                { name: "depthLayers", sampleType: "depth", viewDimension: "2d-array" },
            ],
        });
        const oldColor = texture2d(1);
        const oldShadow = texture2d(2, "depth");
        const oldLayers = texture2dArray(3);
        const oldDepthLayers = texture2dArray(4, "depth");
        setShaderTexture(material, "color", oldColor);
        setShaderTexture(material, "shadow", oldShadow);
        setShaderTexture(material, "layers", oldLayers);
        setShaderTexture(material, "depthLayers", oldDepthLayers);
        const before = material._resourceVersion;

        const failures: readonly [MaterialTextureBindingId, object][] = [
            ["shader.sampler:color", texture2dArray(10)],
            ["shader.sampler:color", texture2d(11, "depth")],
            ["shader.sampler:shadow", texture2d(12)],
            ["shader.sampler:layers", texture2d(13)],
            ["shader.sampler:depthLayers", texture2dArray(14)],
            ["shader.sampler:color", { width: 1, height: 1 }],
        ];
        for (const [id, texture] of failures) {
            await expect(setTexture(material, id, { direction: "replace", texture })).rejects.toThrow();
        }

        const throwingTexture = {
            texture: {} as GPUTexture,
            get view(): GPUTextureView {
                throw new Error("view creation failed");
            },
            sampler: {} as GPUSampler,
            width: 8,
            height: 4,
            _sampleType: "float",
        };
        await expect(setTexture(material, "shader.sampler:color", { direction: "replace", texture: throwingTexture })).rejects.toThrow("view creation failed");
        expect(material._resourceVersion).toBe(before);
        expect(material._textureSlots.get("color")!.current).toBe(oldColor);
        expect(material._textureSlots.get("shadow")!.current).toBe(oldShadow);
        expect(material._textureSlots.get("layers")!.current).toBe(oldLayers);
        expect(material._textureSlots.get("depthLayers")!.current).toBe(oldDepthLayers);
    });

    it("treats repeated assignment and clearing an empty slot as no-ops", async () => {
        const material = createShader({ samplers: ["color", "empty"] });
        const color = texture2d(1);
        setShaderTexture(material, "color", color);
        const before = material._resourceVersion;

        await expect(setTexture(material, "shader.sampler:color", { direction: "replace", texture: color })).resolves.toEqual({
            changed: false,
            mutation: "A",
            postMutation: "none",
        });
        await expect(setTexture(material, "shader.sampler:empty", { direction: "clear" })).rejects.toThrow(/does not support "clear"/);
        expect(material._resourceVersion).toBe(before);
        expect(material._textureSlots.get("color")!.current).toBe(color);
        expect(material._textureSlots.get("empty")!.current).toBeNull();
    });
});
