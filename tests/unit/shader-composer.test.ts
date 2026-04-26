import { describe, it, expect } from "vitest";
import { computeUboLayout } from "../../packages/babylon-lite/src/shader/ubo-layout";
import { composeShader } from "../../packages/babylon-lite/src/shader/shader-composer";
import type { ShaderFragment, ShaderTemplate, UboField } from "../../packages/babylon-lite/src/shader/fragment-types";

// WebGPU shader stage constants for testing (Node has no GPUShaderStage global)
const _VERTEX = 0x1;
const FRAGMENT = 0x2;

// ── UBO Layout Tests ────────────────────────────────────────────

describe("computeUboLayout", () => {
    it("returns zero bytes for empty fields", () => {
        const spec = computeUboLayout([]);
        expect(spec.totalBytes).toBe(0);
        expect(spec.offsets.size).toBe(0);
        expect(spec.structBody).toBe("");
    });

    it("lays out a single f32 at offset 0, total 16 (aligned)", () => {
        const spec = computeUboLayout([{ name: "x", type: "f32" }]);
        expect(spec.offsets.get("x")).toBe(0);
        expect(spec.totalBytes).toBe(16); // rounded up to 16
    });

    it("lays out vec4<f32> at offset 0, total 16", () => {
        const spec = computeUboLayout([{ name: "color", type: "vec4<f32>" }]);
        expect(spec.offsets.get("color")).toBe(0);
        expect(spec.totalBytes).toBe(16);
    });

    it("lays out mat4x4<f32> at offset 0, total 64", () => {
        const spec = computeUboLayout([{ name: "world", type: "mat4x4<f32>" }]);
        expect(spec.offsets.get("world")).toBe(0);
        expect(spec.totalBytes).toBe(64);
    });

    it("aligns vec3<f32> to 16 bytes", () => {
        const fields: UboField[] = [
            { name: "a", type: "f32" }, // offset 0, size 4
            { name: "b", type: "vec3<f32>" }, // needs 16-byte alignment → offset 16, size 12
        ];
        const spec = computeUboLayout(fields);
        expect(spec.offsets.get("a")).toBe(0);
        expect(spec.offsets.get("b")).toBe(16);
        expect(spec.totalBytes).toBe(32); // 16 + 12 = 28, aligned to 32
    });

    it("aligns vec2<f32> to 8 bytes", () => {
        const fields: UboField[] = [
            { name: "a", type: "f32" }, // offset 0
            { name: "b", type: "vec2<f32>" }, // needs 8-byte alignment → offset 8
        ];
        const spec = computeUboLayout(fields);
        expect(spec.offsets.get("a")).toBe(0);
        expect(spec.offsets.get("b")).toBe(8);
        expect(spec.totalBytes).toBe(16);
    });

    it("handles PBR-like base UBO layout: mat4 + 4 floats", () => {
        const fields: UboField[] = [
            { name: "world", type: "mat4x4<f32>" }, // offset 0, 64 bytes
            { name: "envIntensity", type: "f32" }, // offset 64
            { name: "directIntensity", type: "f32" }, // offset 68
            { name: "reflectance", type: "f32" }, // offset 72
            { name: "alpha", type: "f32" }, // offset 76
        ];
        const spec = computeUboLayout(fields);
        expect(spec.offsets.get("world")).toBe(0);
        expect(spec.offsets.get("envIntensity")).toBe(64);
        expect(spec.offsets.get("directIntensity")).toBe(68);
        expect(spec.offsets.get("reflectance")).toBe(72);
        expect(spec.offsets.get("alpha")).toBe(76);
        expect(spec.totalBytes).toBe(80); // 80 is already 16-aligned
    });

    it("handles clearcoat-like extension fields after base", () => {
        const fields: UboField[] = [
            { name: "world", type: "mat4x4<f32>" },
            { name: "envIntensity", type: "f32" },
            { name: "directIntensity", type: "f32" },
            { name: "reflectance", type: "f32" },
            { name: "alpha", type: "f32" },
            { name: "ccParams", type: "vec4<f32>" }, // needs 16-align → offset 80
            { name: "ccRefraction", type: "vec4<f32>" }, // offset 96
        ];
        const spec = computeUboLayout(fields);
        expect(spec.offsets.get("ccParams")).toBe(80);
        expect(spec.offsets.get("ccRefraction")).toBe(96);
        expect(spec.totalBytes).toBe(112);
    });

    it("generates correct WGSL struct body", () => {
        const fields: UboField[] = [
            { name: "world", type: "mat4x4<f32>" },
            { name: "alpha", type: "f32" },
        ];
        const spec = computeUboLayout(fields);
        expect(spec.structBody).toContain("world: mat4x4<f32>,");
        expect(spec.structBody).toContain("alpha: f32,");
    });
});

// ── Shader Composer Tests ───────────────────────────────────────

/** Minimal template for testing */
function makeTemplate(overrides?: Partial<ShaderTemplate>): ShaderTemplate {
    return {
        vertexTemplate: [
            "/*SU*/",
            "@group(0) @binding(0) var<uniform> scene: SceneUniforms;",
            "/*MU*/",
            "@group(1) @binding(0) var<uniform> mesh: MeshUniforms;",
            "/*VD*/",
            "/*VI*/",
            "/*VO*/",
            "@vertex fn main(input: VertexInput) -> VertexOutput {",
            "var out: VertexOutput;",
            "/*VR*/",
            "/*VW*/",
            "/*VB*/",
            "return out;",
            "}",
        ].join("\n"),
        fragmentTemplate: [
            "/*SU*/",
            "@group(0) @binding(0) var<uniform> scene: SceneUniforms;",
            "/*MU*/",
            "@group(1) @binding(0) var<uniform> mesh: MeshUniforms;",
            "/*FB*/",
            "/*FI*/",
            "/*HF*/",
            "@fragment fn main(input: FragmentInput) -> @location(0) vec4<f32> {",
            "/*SV*/",
            "var color = vec4<f32>(1.0);",
            "/*AT*/",
            "/*AC*/",
            "/*MF*/",
            "/*BL*/",
            "/*AD*/",
            "/*AI*/",
            "/*NI*/",
            "/*BC*/",
            "/*BA*/",
            "return color;",
            "}",
        ].join("\n"),
        baseMeshUboFields: [{ name: "world", type: "mat4x4<f32>" }],
        baseSceneUboFields: [{ name: "viewProj", type: "mat4x4<f32>" }],
        baseVertexAttributes: [
            { name: "position", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
            { name: "normal", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
        ],
        baseVaryings: [
            { name: "worldPos", type: "vec3<f32>" },
            { name: "worldNormal", type: "vec3<f32>" },
        ],
        ...overrides,
    };
}

describe("composeShader", () => {
    it("composes with zero fragments", () => {
        const result = composeShader(makeTemplate(), []);
        expect(result.fragmentKey).toBe("");
        expect(result.vertexWGSL).toContain("struct SceneUniforms");
        expect(result.vertexWGSL).toContain("struct MeshUniforms");
        expect(result.vertexWGSL).toContain("struct VertexInput");
        expect(result.vertexWGSL).toContain("struct VertexOutput");
        expect(result.fragmentWGSL).toContain("struct FragmentInput");
        expect(result.meshUboSpec.totalBytes).toBe(64); // just world mat4
        expect(result.sceneUboSpec.totalBytes).toBe(64); // just viewProj mat4
    });

    it("generates correct fragment key from sorted fragment IDs", () => {
        const fragA: ShaderFragment = { id: "alpha" };
        const fragB: ShaderFragment = { id: "beta", dependencies: ["alpha"] };
        const result = composeShader(makeTemplate(), [fragB, fragA]); // given out of order
        expect(result.fragmentKey).toBe("alpha|beta");
    });

    it("appends fragment UBO fields to mesh UBO", () => {
        const frag: ShaderFragment = {
            id: "clearcoat",
            uboFields: [
                { name: "ccParams", type: "vec4<f32>" },
                { name: "ccRefraction", type: "vec4<f32>" },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.meshUboSpec.totalBytes).toBe(96); // 64 (world) + 16 + 16
        expect(result.meshUboSpec.offsets.get("ccParams")).toBe(64);
        expect(result.meshUboSpec.offsets.get("ccRefraction")).toBe(80);
        expect(result.fragmentUboOffsets.get("clearcoat")).toBe(16); // 64 / 4 = float offset 16
    });

    it("appends fragment scene UBO fields", () => {
        const frag: ShaderFragment = {
            id: "ibl",
            sceneUboFields: [
                { name: "shCoeff0", type: "vec4<f32>" },
                { name: "shCoeff1", type: "vec4<f32>" },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.sceneUboSpec.totalBytes).toBe(96); // 64 (viewProj) + 16 + 16
        expect(result.sceneUboSpec.offsets.get("shCoeff0")).toBe(64);
    });

    it("injects fragment slot code into the template", () => {
        const frag: ShaderFragment = {
            id: "test",
            fragmentSlots: {
                SV: "var myVar = 1.0;",
                AI: "color += vec4<f32>(0.1);",
            },
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.fragmentWGSL).toContain("var myVar = 1.0;");
        expect(result.fragmentWGSL).toContain("color += vec4<f32>(0.1);");
        // Slot markers should be replaced (not present)
        expect(result.fragmentWGSL).not.toMatch(/\/\*SV\*\//);
    });

    it("concatenates multiple fragment contributions at the same slot", () => {
        const fragA: ShaderFragment = {
            id: "alpha",
            fragmentSlots: { AD: "// from alpha" },
        };
        const fragB: ShaderFragment = {
            id: "beta",
            fragmentSlots: { AD: "// from beta" },
        };
        const result = composeShader(makeTemplate(), [fragA, fragB]);
        const idx1 = result.fragmentWGSL.indexOf("// from alpha");
        const idx2 = result.fragmentWGSL.indexOf("// from beta");
        expect(idx1).toBeGreaterThan(-1);
        expect(idx2).toBeGreaterThan(-1);
        expect(idx1).toBeLessThan(idx2); // alpha before beta (alphabetical, both have no deps)
    });

    it("injects vertex slot code", () => {
        const frag: ShaderFragment = {
            id: "skeleton",
            vertexSlots: {
                VW: "let finalWorld = computeSkinning();",
            },
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.vertexWGSL).toContain("let finalWorld = computeSkinning();");
    });

    it("adds fragment vertex attributes to VertexInput and pipeline layouts", () => {
        const frag: ShaderFragment = {
            id: "ti",
            vertexAttributes: [
                { name: "world0", type: "vec4<f32>", gpuFormat: "float32x4", arrayStride: 64, stepMode: "instance", bufferGroup: "ti", offset: 0 },
                { name: "world1", type: "vec4<f32>", gpuFormat: "float32x4", arrayStride: 64, stepMode: "instance", bufferGroup: "ti", offset: 16 },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.vertexWGSL).toContain("@location(2) world0: vec4<f32>");
        expect(result.vertexWGSL).toContain("@location(3) world1: vec4<f32>");

        // Should have 3 vertex buffer layouts: position, normal (ungrouped) + ti group
        expect(result.vertexBufferLayouts.length).toBe(3);
        const tiLayout = result.vertexBufferLayouts.find((l) => l.stepMode === "instance");
        expect(tiLayout).toBeDefined();
        expect(tiLayout!.arrayStride).toBe(64);
        expect(tiLayout!.attributes.length).toBe(2);
    });

    it("adds fragment varyings to VertexOutput and FragmentInput", () => {
        const frag: ShaderFragment = {
            id: "ti",
            varyings: [{ name: "vInstanceColor", type: "vec4<f32>" }],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.vertexWGSL).toContain("vInstanceColor: vec4<f32>");
        expect(result.fragmentWGSL).toContain("vInstanceColor: vec4<f32>");
    });

    it("auto-assigns binding indices for fragment bindings", () => {
        const frag: ShaderFragment = {
            id: "env",
            bindings: [
                { name: "brdfLUT", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: FRAGMENT },
                { name: "brdfSampler_", type: { kind: "sampler", samplerType: "sampler" }, visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // mesh UBO at binding 0, then fragment bindings start at 1
        expect(result.fragmentWGSL).toContain("@group(1) @binding(1) var brdfLUT: texture_2d<f32>");
        expect(result.fragmentWGSL).toContain("@group(1) @binding(2) var brdfSampler_: sampler");
        expect(result.fragmentBindingOffsets.get("env")).toBe(1);
    });

    it("puts shadow bindings in group 2", () => {
        const frag: ShaderFragment = {
            id: "shadow",
            bindings: [
                { name: "shadowTex", type: { kind: "texture", textureType: "texture_depth_2d" }, group: "shadow", visibility: FRAGMENT },
                { name: "shadowSamp", type: { kind: "sampler", samplerType: "sampler_comparison" }, group: "shadow", visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result.fragmentWGSL).toContain("@group(2) @binding(0) var shadowTex: texture_depth_2d");
        expect(result.fragmentWGSL).toContain("@group(2) @binding(1) var shadowSamp: sampler_comparison");
        expect(result.shadowBGLDescriptor).not.toBeNull();
        expect(result.shadowBGLDescriptor!.entries.length).toBe(2);
    });

    it("throws on duplicate fragment IDs", () => {
        const frag: ShaderFragment = { id: "dupe" };
        expect(() => composeShader(makeTemplate(), [frag, frag])).toThrow("Duplicate fragment id");
    });

    it("throws on missing dependency", () => {
        const frag: ShaderFragment = { id: "child", dependencies: ["nonexistent"] };
        expect(() => composeShader(makeTemplate(), [frag])).toThrow('depends on unknown fragment "nonexistent"');
    });

    it("throws on circular dependency", () => {
        const a: ShaderFragment = { id: "a", dependencies: ["b"] };
        const b: ShaderFragment = { id: "b", dependencies: ["a"] };
        expect(() => composeShader(makeTemplate(), [a, b])).toThrow("Cycle detected");
    });

    it("respects dependency order for slot injection", () => {
        const base: ShaderFragment = {
            id: "base-ext",
            fragmentSlots: { SV: "// base-ext first" },
        };
        const dependent: ShaderFragment = {
            id: "dependent",
            dependencies: ["base-ext"],
            fragmentSlots: { SV: "// dependent second" },
        };
        // Provide in reverse order to prove topoSort works
        const result = composeShader(makeTemplate(), [dependent, base]);
        const idx1 = result.fragmentWGSL.indexOf("// base-ext first");
        const idx2 = result.fragmentWGSL.indexOf("// dependent second");
        expect(idx1).toBeLessThan(idx2);
    });

    it("generates mesh BGL descriptor with correct entries", () => {
        const frag: ShaderFragment = {
            id: "env",
            bindings: [
                { name: "tex", type: { kind: "texture", textureType: "texture_cube<f32>" }, visibility: FRAGMENT },
                { name: "samp", type: { kind: "sampler", samplerType: "sampler" }, visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // mesh UBO + 2 fragment bindings = 3 entries
        expect(result.meshBGLDescriptor.entries.length).toBe(3);
        const firstEntry = result.meshBGLDescriptor.entries[0] as GPUBindGroupLayoutEntry;
        expect(firstEntry.binding).toBe(0);
        expect(firstEntry.buffer).toEqual({ type: "uniform" });
    });

    it("deduplicates vertex attributes by name", () => {
        const frag: ShaderFragment = {
            id: "test",
            vertexAttributes: [
                // Same as base "position" — should be deduped
                { name: "position", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // Should only have 2 vertex buffer layouts (position + normal), not 3
        expect(result.vertexBufferLayouts.length).toBe(2);
    });

    it("handles base template bindings before fragment bindings", () => {
        const template = makeTemplate({
            baseBindings: [
                { name: "baseColorTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: FRAGMENT },
                { name: "baseColorSamp", type: { kind: "sampler", samplerType: "sampler" }, visibility: FRAGMENT },
            ],
        });
        const frag: ShaderFragment = {
            id: "env",
            bindings: [{ name: "envTex", type: { kind: "texture", textureType: "texture_cube<f32>" }, visibility: FRAGMENT }],
        };
        const result = composeShader(template, [frag]);
        // binding 0 = mesh UBO, 1 = baseColorTex, 2 = baseColorSamp, 3 = envTex
        expect(result.fragmentWGSL).toContain("@group(1) @binding(1) var baseColorTex");
        expect(result.fragmentWGSL).toContain("@group(1) @binding(2) var baseColorSamp");
        expect(result.fragmentWGSL).toContain("@group(1) @binding(3) var envTex");
    });
});
