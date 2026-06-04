/**
 * Shader Fragment Composition System — Type Definitions
 *
 * A ShaderFragment declares everything a rendering feature needs:
 * shader code, bindings, vertex attributes, UBO fields, varyings.
 * The ShaderComposer assembles fragments into final WGSL + GPU layouts.
 *
 * Zero global state. Zero WGSL strings in the composer. All shader
 * text lives in fragment modules for full tree-shaking.
 */

// ── WGSL types ──────────────────────────────────────────────────

/** Scalar, vector, matrix, and fixed-array WGSL types for UBO fields */
export type WgslScalarType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "vec4<u32>" | "mat4x4<f32>" | `array<vec4<u32>, ${number}>`;

// ── Vertex attributes ───────────────────────────────────────────

export interface VertexAttribute {
    /** @internal WGSL variable name in the vertex input (e.g. "position", "world0") */
    readonly _name: string;
    /** @internal WGSL type (e.g. "vec3<f32>", "vec4<f32>") */
    readonly _type: string;
    /** @internal WebGPU vertex format (e.g. "float32x3", "float32x4") */
    readonly _gpuFormat: GPUVertexFormat;
    /** @internal Byte stride of the vertex buffer this attribute lives in */
    readonly _arrayStride: number;
    /** @internal Step mode — default "vertex" */
    readonly _stepMode?: GPUVertexStepMode;
    /**
     * Attributes sharing the same bufferGroup are packed into one vertex buffer.
     * E.g. thin-instance world0-world3 share bufferGroup "ti-matrix".
     * Attributes without a bufferGroup get their own buffer.
     * @internal
     */
    readonly _bufferGroup?: string;
    /** @internal Byte offset within the buffer (for packed multi-attribute buffers). Default 0. */
    readonly _offset?: number;
}

// ── Varyings ────────────────────────────────────────────────────

export interface Varying {
    /** @internal WGSL variable name (e.g. "worldPos", "vInstanceColor") */
    readonly _name: string;
    /** @internal WGSL type (e.g. "vec3<f32>") */
    readonly _type: string;
}

// ── UBO fields ──────────────────────────────────────────────────

export interface UboField {
    /** @internal WGSL field name (e.g. "emissiveColor", "ccParams") */
    readonly _name: string;
    /** @internal WGSL type */
    readonly _type: WgslScalarType;
}

// ── Bindings ────────────────────────────────────────────────────

export type BindingKind =
    /** @internal */
    | { readonly _kind: "uniform-buffer" }
    | {
          /** @internal */
          readonly _kind: "texture";
          /** @internal */
          readonly _textureType: "texture_2d<f32>" | "texture_cube<f32>" | "texture_depth_2d" | "texture_2d<u32>";
          /** @internal */
          readonly _sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
      }
    /** @internal */
    | { readonly _kind: "sampler"; readonly _samplerType: "sampler" | "sampler_non_filtering" | "sampler_comparison" }
    /** @internal */
    | { readonly _kind: "storage-texture"; readonly _access: "read" | "write" | "read_write"; readonly _format: string };

export interface BindingDecl {
    /** @internal WGSL variable name (e.g. "normalTex", "brdfSampler_") */
    readonly _name: string;
    /** @internal Binding type descriptor */
    readonly _type: BindingKind;
    /** @internal Which bind group: "mesh" (group 1) or "shadow" (group 2). Default: "mesh" */
    readonly _group?: "mesh" | "shadow";
    /** @internal Shader stage visibility flags (e.g. GPUShaderStage.FRAGMENT) */
    readonly _visibility: GPUShaderStageFlags;
}

// ── Fragment slots ──────────────────────────────────────────────

/**
 * Named injection points in the fragment shader.
 *
 * Mapping from current PBR hooks:
 *   HOOK_HELPERS        → HF
 *   HOOK_SV     → SV
 *   HOOK_MF      → MF
 *   HOOK_AFTER_SHADOWS  → AS
 *   HOOK_AFTER_DIRECT   → AD
 *   HOOK_NO_LIGHT_VARS  → BL
 *   HOOK_AI      → AI
 *   HOOK_NI  → NI
 */
export type FragmentSlot = "HF" | "SV" | "AT" | "AC" | "MF" | "BL" | "AS" | "AD" | "AI" | "NI" | "BC" | "BA";

// ── Vertex injection points ─────────────────────────────────────

/**
 * Named injection points in the vertex shader.
 *
 * VR: before main body (morph pre-skinning)
 * VW:    computes finalWorld (skeleton skinning, thin-instance)
 * VB:     after world transform (varying passthrough)
 */
export type VertexSlot = "VR" | "VW" | "VB";

// ── The ShaderFragment interface ────────────────────────────────

export interface ShaderFragment {
    /** @internal Unique ID for dedup and dependency resolution (e.g. "clearcoat", "skeleton") */
    readonly _id: string;

    /** @internal Fragment IDs that must be composed before this one */
    readonly _dependencies?: readonly string[];

    // ── Vertex stage ──

    /** @internal Extra vertex input attributes */
    readonly _vertexAttributes?: readonly VertexAttribute[];

    /** @internal Extra vertex→fragment varyings */
    readonly _varyings?: readonly Varying[];

    /** @internal Extra `@group(1)` bindings used in the vertex shader (skeleton bone tex, morph tex+uniforms) */
    readonly _vertexBindings?: readonly BindingDecl[];

    /** @internal WGSL code injected at named vertex slots */
    readonly _vertexSlots?: Partial<Record<VertexSlot, string>>;

    /** @internal Extra pipeline vertex buffer layouts (skeleton joints/weights).
     *  Called with next available shader location. Returns layouts + next location. */
    readonly _pipelineVertexBuffers?: (nextLoc: number) => { _buffers: GPUVertexBufferLayout[]; _nextLoc: number };

    /** @internal `@builtin` declarations for vertex function params (e.g. vertex_index for morph targets) */
    readonly _vertexBuiltins?: readonly { readonly _name: string; readonly _builtin: string; readonly _type: string }[];

    /** @internal WGSL helper functions / struct definitions injected before `@vertex` fn main */
    readonly _vertexHelperFunctions?: string;

    // ── Fragment stage ──

    /** @internal UBO fields appended to MeshUniforms (mesh bind group) */
    readonly _uboFields?: readonly UboField[];

    /** @internal Extra bindings (textures, samplers) in the fragment shader */
    readonly _bindings?: readonly BindingDecl[];

    /** @internal WGSL helper functions injected before `@fragment` fn main */
    readonly _helperFunctions?: string;

    /** @internal Code injected at named fragment slots */
    readonly _fragmentSlots?: Partial<Record<FragmentSlot, string>>;
}

// ── Shader template ─────────────────────────────────────────────

/**
 * A ShaderTemplate provides the base shader structure for a material family
 * (PBR, Standard). It contains WGSL with comment markers where fragments
 * inject their code. The template is material-specific; the composer is generic.
 *
 * Markers use the format: / *SLOT_NAME* / (without spaces around *)
 * The composer replaces each marker with concatenated fragment contributions.
 */
export interface ShaderTemplate {
    /** @internal Base vertex shader WGSL with slot markers */
    readonly _vertexTemplate: string;
    /** @internal Base fragment shader WGSL with slot markers */
    readonly _fragmentTemplate: string;
    /** @internal Base mesh UBO fields (e.g. world matrix for PBR, or mesh+lights+material for Standard) */
    readonly _baseMeshUboFields: readonly UboField[];
    /** @internal Base vertex attributes (e.g. position, normal) */
    readonly _baseVertexAttributes: readonly VertexAttribute[];
    /** @internal Base varyings (e.g. worldPos, worldNormal, uv) */
    readonly _baseVaryings: readonly Varying[];
    /** @internal Base fragment bindings (e.g. baseColor texture for PBR, or diffuse/lights/material for Standard) */
    readonly _baseBindings?: readonly BindingDecl[];
    /** @internal Base vertex bindings (UBOs used in the vertex shader beyond mesh UBO) */
    readonly _baseVertexBindings?: readonly BindingDecl[];
    /** Base material UBO fields (e.g. reflectance, intensity). When provided,
     *  packed into a separate MaterialUniforms UBO at group 1 binding 1,
     *  and fragment uboFields also target the material UBO instead of mesh UBO. */
    /** @internal */
    readonly _baseMaterialUboFields?: readonly UboField[];
}

// ── Composed output ─────────────────────────────────────────────

/** Computed byte layout for a UBO struct */
export interface UboSpec {
    /** @internal Total byte size (aligned to 16 bytes) */
    readonly _totalBytes: number;
    /** @internal Map from field name → byte offset */
    readonly _offsets: ReadonlyMap<string, number>;
    /** @internal Generated WGSL struct body (fields only, no `struct Name {}`  wrapper) */
    readonly _structBody: string;
}

/** The output of composeShader() — everything needed to create a GPU pipeline */
export interface ComposedShader {
    /** @internal Final vertex WGSL source */
    readonly _vertexWGSL: string;
    /** @internal Final fragment WGSL source */
    readonly _fragmentWGSL: string;
    /** @internal Mesh bind group layout descriptor (group 1) */
    readonly _meshBGLDescriptor: GPUBindGroupLayoutDescriptor;
    /** @internal Shadow bind group layout descriptor (group 2), or null */
    readonly _shadowBGLDescriptor: GPUBindGroupLayoutDescriptor | null;
    /** @internal Vertex buffer layouts for pipeline descriptor */
    readonly _vertexBufferLayouts: GPUVertexBufferLayout[];
    /** @internal Mesh UBO spec */
    readonly _meshUboSpec: UboSpec;
    /** @internal Material UBO spec (present when template provides baseMaterialUboFields) */
    readonly _materialUboSpec?: UboSpec;
    /** @internal Sorted fragment IDs joined with "|" — used as part of pipeline cache key */
    readonly _fragmentKey: string;
}
