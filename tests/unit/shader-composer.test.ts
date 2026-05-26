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
        expect(spec._totalBytes).toBe(0);
        expect(spec._offsets.size).toBe(0);
        expect(spec._structBody).toBe("");
    });

    it("lays out a single f32 at offset 0, total 16 (aligned)", () => {
        const spec = computeUboLayout([{ _name: "x", _type: "f32" }]);
        expect(spec._offsets.get("x")).toBe(0);
        expect(spec._totalBytes).toBe(16); // rounded up to 16
    });

    it("lays out vec4<f32> at offset 0, total 16", () => {
        const spec = computeUboLayout([{ _name: "color", _type: "vec4<f32>" }]);
        expect(spec._offsets.get("color")).toBe(0);
        expect(spec._totalBytes).toBe(16);
    });

    it("lays out mat4x4<f32> at offset 0, total 64", () => {
        const spec = computeUboLayout([{ _name: "world", _type: "mat4x4<f32>" }]);
        expect(spec._offsets.get("world")).toBe(0);
        expect(spec._totalBytes).toBe(64);
    });

    it("aligns vec3<f32> to 16 bytes", () => {
        const fields: UboField[] = [
            { _name: "a", _type: "f32" }, // offset 0, size 4
            { _name: "b", _type: "vec3<f32>" }, // needs 16-byte alignment → offset 16, size 12
        ];
        const spec = computeUboLayout(fields);
        expect(spec._offsets.get("a")).toBe(0);
        expect(spec._offsets.get("b")).toBe(16);
        expect(spec._totalBytes).toBe(32); // 16 + 12 = 28, aligned to 32
    });

    it("aligns vec2<f32> to 8 bytes", () => {
        const fields: UboField[] = [
            { _name: "a", _type: "f32" }, // offset 0
            { _name: "b", _type: "vec2<f32>" }, // needs 8-byte alignment → offset 8
        ];
        const spec = computeUboLayout(fields);
        expect(spec._offsets.get("a")).toBe(0);
        expect(spec._offsets.get("b")).toBe(8);
        expect(spec._totalBytes).toBe(16);
    });

    it("handles PBR-like base UBO layout: mat4 + 4 floats", () => {
        const fields: UboField[] = [
            { _name: "world", _type: "mat4x4<f32>" }, // offset 0, 64 bytes
            { _name: "envIntensity", _type: "f32" }, // offset 64
            { _name: "directIntensity", _type: "f32" }, // offset 68
            { _name: "reflectance", _type: "f32" }, // offset 72
            { _name: "alpha", _type: "f32" }, // offset 76
        ];
        const spec = computeUboLayout(fields);
        expect(spec._offsets.get("world")).toBe(0);
        expect(spec._offsets.get("envIntensity")).toBe(64);
        expect(spec._offsets.get("directIntensity")).toBe(68);
        expect(spec._offsets.get("reflectance")).toBe(72);
        expect(spec._offsets.get("alpha")).toBe(76);
        expect(spec._totalBytes).toBe(80); // 80 is already 16-aligned
    });

    it("handles clearcoat-like extension fields after base", () => {
        const fields: UboField[] = [
            { _name: "world", _type: "mat4x4<f32>" },
            { _name: "envIntensity", _type: "f32" },
            { _name: "directIntensity", _type: "f32" },
            { _name: "reflectance", _type: "f32" },
            { _name: "alpha", _type: "f32" },
            { _name: "ccParams", _type: "vec4<f32>" }, // needs 16-align → offset 80
            { _name: "ccRefraction", _type: "vec4<f32>" }, // offset 96
        ];
        const spec = computeUboLayout(fields);
        expect(spec._offsets.get("ccParams")).toBe(80);
        expect(spec._offsets.get("ccRefraction")).toBe(96);
        expect(spec._totalBytes).toBe(112);
    });

    it("generates correct WGSL struct body", () => {
        const fields: UboField[] = [
            { _name: "world", _type: "mat4x4<f32>" },
            { _name: "alpha", _type: "f32" },
        ];
        const spec = computeUboLayout(fields);
        expect(spec._structBody).toContain("world: mat4x4<f32>,");
        expect(spec._structBody).toContain("alpha: f32,");
    });
});

// ── Shader Composer Tests ───────────────────────────────────────

/** Minimal template for testing */
function makeTemplate(overrides?: Partial<ShaderTemplate>): ShaderTemplate {
    return {
        _vertexTemplate: [
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
        _fragmentTemplate: [
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
        _baseMeshUboFields: [{ _name: "world", _type: "mat4x4<f32>" }],
        _baseVertexAttributes: [
            { _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
            { _name: "normal", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
        ],
        _baseVaryings: [
            { _name: "worldPos", _type: "vec3<f32>" },
            { _name: "worldNormal", _type: "vec3<f32>" },
        ],
        ...overrides,
    };
}

describe("composeShader", () => {
    it("composes with zero fragments", () => {
        const result = composeShader(makeTemplate(), []);
        expect(result._fragmentKey).toBe("");
        expect(result._vertexWGSL).toContain("struct SceneUniforms");
        expect(result._vertexWGSL).toContain("struct MeshUniforms");
        expect(result._vertexWGSL).toContain("struct VertexInput");
        expect(result._vertexWGSL).toContain("struct VertexOutput");
        expect(result._fragmentWGSL).toContain("struct FragmentInput");
        expect(result._meshUboSpec._totalBytes).toBe(64); // just world mat4
        expect(result._vertexWGSL).toContain("viewProjection: mat4x4<f32>");
        expect(result._fragmentWGSL).toContain("@group(0) @binding(0) var<uniform> scene: SceneUniforms");
    });

    it("generates correct fragment key from sorted fragment IDs", () => {
        const fragA: ShaderFragment = { _id: "alpha" };
        const fragB: ShaderFragment = { _id: "beta", _dependencies: ["alpha"] };
        const result = composeShader(makeTemplate(), [fragB, fragA]); // given out of order
        expect(result._fragmentKey).toBe("alpha|beta");
    });

    it("appends fragment UBO fields to mesh UBO", () => {
        const frag: ShaderFragment = {
            _id: "clearcoat",
            _uboFields: [
                { _name: "ccParams", _type: "vec4<f32>" },
                { _name: "ccRefraction", _type: "vec4<f32>" },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._meshUboSpec._totalBytes).toBe(96); // 64 (world) + 16 + 16
        expect(result._meshUboSpec._offsets.get("ccParams")).toBe(64);
        expect(result._meshUboSpec._offsets.get("ccRefraction")).toBe(80);
    });

    it("uses the canonical scene UBO layout for all fragments", () => {
        const frag: ShaderFragment = { _id: "ibl" };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._vertexWGSL).toContain("vSphericalL00");
        expect(result._fragmentWGSL).toContain("vFogColor");
    });

    it("injects fragment slot code into the template", () => {
        const frag: ShaderFragment = {
            _id: "test",
            _fragmentSlots: {
                SV: "var myVar = 1.0;",
                AI: "color += vec4<f32>(0.1);",
            },
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._fragmentWGSL).toContain("var myVar = 1.0;");
        expect(result._fragmentWGSL).toContain("color += vec4<f32>(0.1);");
        // Slot markers should be replaced (not present)
        expect(result._fragmentWGSL).not.toMatch(/\/\*SV\*\//);
    });

    it("concatenates multiple fragment contributions at the same slot", () => {
        const fragA: ShaderFragment = {
            _id: "alpha",
            _fragmentSlots: { AD: "// from alpha" },
        };
        const fragB: ShaderFragment = {
            _id: "beta",
            _fragmentSlots: { AD: "// from beta" },
        };
        const result = composeShader(makeTemplate(), [fragA, fragB]);
        const idx1 = result._fragmentWGSL.indexOf("// from alpha");
        const idx2 = result._fragmentWGSL.indexOf("// from beta");
        expect(idx1).toBeGreaterThan(-1);
        expect(idx2).toBeGreaterThan(-1);
        expect(idx1).toBeLessThan(idx2); // alpha before beta (alphabetical, both have no deps)
    });

    it("injects vertex slot code", () => {
        const frag: ShaderFragment = {
            _id: "skeleton",
            _vertexSlots: {
                VW: "let finalWorld = computeSkinning();",
            },
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._vertexWGSL).toContain("let finalWorld = computeSkinning();");
    });

    it("adds fragment vertex attributes to VertexInput and pipeline layouts", () => {
        const frag: ShaderFragment = {
            _id: "ti",
            _vertexAttributes: [
                { _name: "world0", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 64, _stepMode: "instance", _bufferGroup: "ti", _offset: 0 },
                { _name: "world1", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 64, _stepMode: "instance", _bufferGroup: "ti", _offset: 16 },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._vertexWGSL).toContain("@location(2) world0:vec4<f32>");
        expect(result._vertexWGSL).toContain("@location(3) world1:vec4<f32>");

        // Should have 3 vertex buffer layouts: position, normal (ungrouped) + ti group
        expect(result._vertexBufferLayouts.length).toBe(3);
        const tiLayout = result._vertexBufferLayouts.find((l) => l.stepMode === "instance");
        expect(tiLayout).toBeDefined();
        expect(tiLayout!.arrayStride).toBe(64);
        expect(tiLayout!.attributes.length).toBe(2);
    });

    it("adds fragment varyings to VertexOutput and FragmentInput", () => {
        const frag: ShaderFragment = {
            _id: "ti",
            _varyings: [{ _name: "vInstanceColor", _type: "vec4<f32>" }],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._vertexWGSL).toContain("vInstanceColor:vec4<f32>");
        expect(result._fragmentWGSL).toContain("vInstanceColor:vec4<f32>");
    });

    it("auto-assigns binding indices for fragment bindings", () => {
        const frag: ShaderFragment = {
            _id: "env",
            _bindings: [
                { _name: "brdfLUT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: FRAGMENT },
                { _name: "brdfSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // mesh UBO at binding 0, then fragment bindings start at 1
        expect(result._fragmentWGSL).toContain("@group(1)@binding(1) var brdfLUT:texture_2d<f32>");
        expect(result._fragmentWGSL).toContain("@group(1)@binding(2) var brdfSampler_:sampler");
    });

    it("puts shadow bindings in group 2", () => {
        const frag: ShaderFragment = {
            _id: "shadow",
            _bindings: [
                { _name: "shadowTex", _type: { _kind: "texture", _textureType: "texture_depth_2d" }, _group: "shadow", _visibility: FRAGMENT },
                { _name: "shadowSamp", _type: { _kind: "sampler", _samplerType: "sampler_comparison" }, _group: "shadow", _visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        expect(result._fragmentWGSL).toContain("@group(2)@binding(0) var shadowTex:texture_depth_2d");
        expect(result._fragmentWGSL).toContain("@group(2)@binding(1) var shadowSamp:sampler_comparison");
        expect(result._shadowBGLDescriptor).not.toBeNull();
        expect(result._shadowBGLDescriptor!.entries.length).toBe(2);
    });

    it("throws on duplicate fragment IDs", () => {
        const frag: ShaderFragment = { _id: "dupe" };
        expect(() => composeShader(makeTemplate(), [frag, frag])).toThrow();
    });

    it("throws on missing dependency", () => {
        const frag: ShaderFragment = { _id: "child", _dependencies: ["nonexistent"] };
        expect(() => composeShader(makeTemplate(), [frag])).toThrow();
    });

    it("throws on circular dependency", () => {
        const a: ShaderFragment = { _id: "a", _dependencies: ["b"] };
        const b: ShaderFragment = { _id: "b", _dependencies: ["a"] };
        expect(() => composeShader(makeTemplate(), [a, b])).toThrow();
    });

    it("respects dependency order for slot injection", () => {
        const base: ShaderFragment = {
            _id: "base-ext",
            _fragmentSlots: { SV: "// base-ext first" },
        };
        const dependent: ShaderFragment = {
            _id: "dependent",
            _dependencies: ["base-ext"],
            _fragmentSlots: { SV: "// dependent second" },
        };
        // Provide in reverse order to prove topoSort works
        const result = composeShader(makeTemplate(), [dependent, base]);
        const idx1 = result._fragmentWGSL.indexOf("// base-ext first");
        const idx2 = result._fragmentWGSL.indexOf("// dependent second");
        expect(idx1).toBeLessThan(idx2);
    });

    it("generates mesh BGL descriptor with correct entries", () => {
        const frag: ShaderFragment = {
            _id: "env",
            _bindings: [
                { _name: "tex", _type: { _kind: "texture", _textureType: "texture_cube<f32>" }, _visibility: FRAGMENT },
                { _name: "samp", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: FRAGMENT },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // mesh UBO + 2 fragment bindings = 3 entries
        expect(result._meshBGLDescriptor.entries.length).toBe(3);
        const firstEntry = result._meshBGLDescriptor.entries[0] as GPUBindGroupLayoutEntry;
        expect(firstEntry.binding).toBe(0);
        expect(firstEntry.buffer).toEqual({ type: "uniform" });
    });

    it("deduplicates vertex attributes by name", () => {
        const frag: ShaderFragment = {
            _id: "test",
            _vertexAttributes: [
                // Same as base "position" — should be deduped
                { _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
            ],
        };
        const result = composeShader(makeTemplate(), [frag]);
        // Should only have 2 vertex buffer layouts (position + normal), not 3
        expect(result._vertexBufferLayouts.length).toBe(2);
    });

    it("handles base template bindings before fragment bindings", () => {
        const template = makeTemplate({
            _baseBindings: [
                { _name: "baseColorTex", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: FRAGMENT },
                { _name: "baseColorSamp", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: FRAGMENT },
            ],
        });
        const frag: ShaderFragment = {
            _id: "env",
            _bindings: [{ _name: "envTex", _type: { _kind: "texture", _textureType: "texture_cube<f32>" }, _visibility: FRAGMENT }],
        };
        const result = composeShader(template, [frag]);
        // binding 0 = mesh UBO, 1 = baseColorTex, 2 = baseColorSamp, 3 = envTex
        expect(result._fragmentWGSL).toContain("@group(1)@binding(1) var baseColorTex");
        expect(result._fragmentWGSL).toContain("@group(1)@binding(2) var baseColorSamp");
        expect(result._fragmentWGSL).toContain("@group(1)@binding(3) var envTex");
    });
});
