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

/** Scalar and vector WGSL types for UBO fields */
export type WgslScalarType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";

// ── Vertex attributes ───────────────────────────────────────────

export interface VertexAttribute {
    /** WGSL variable name in the vertex input (e.g. "position", "world0") */
    readonly name: string;
    /** WGSL type (e.g. "vec3<f32>", "vec4<f32>") */
    readonly type: string;
    /** WebGPU vertex format (e.g. "float32x3", "float32x4") */
    readonly gpuFormat: GPUVertexFormat;
    /** Byte stride of the vertex buffer this attribute lives in */
    readonly arrayStride: number;
    /** Step mode — default "vertex" */
    readonly stepMode?: GPUVertexStepMode;
    /**
     * Attributes sharing the same bufferGroup are packed into one vertex buffer.
     * E.g. thin-instance world0-world3 share bufferGroup "ti-matrix".
     * Attributes without a bufferGroup get their own buffer.
     */
    readonly bufferGroup?: string;
    /** Byte offset within the buffer (for packed multi-attribute buffers). Default 0. */
    readonly offset?: number;
}

// ── Varyings ────────────────────────────────────────────────────

export interface Varying {
    /** WGSL variable name (e.g. "worldPos", "vInstanceColor") */
    readonly name: string;
    /** WGSL type (e.g. "vec3<f32>") */
    readonly type: string;
}

// ── UBO fields ──────────────────────────────────────────────────

export interface UboField {
    /** WGSL field name (e.g. "emissiveColor", "ccParams") */
    readonly name: string;
    /** WGSL type */
    readonly type: WgslScalarType;
}

// ── Bindings ────────────────────────────────────────────────────

export type BindingKind =
    | { readonly kind: "uniform-buffer" }
    | {
          readonly kind: "texture";
          readonly textureType: "texture_2d<f32>" | "texture_cube<f32>" | "texture_depth_2d" | "texture_2d<u32>";
          readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
      }
    | { readonly kind: "sampler"; readonly samplerType: "sampler" | "sampler_comparison" }
    | { readonly kind: "storage-texture"; readonly access: "read" | "write" | "read_write"; readonly format: string };

export interface BindingDecl {
    /** WGSL variable name (e.g. "normalTex", "brdfSampler_") */
    readonly name: string;
    /** Binding type descriptor */
    readonly type: BindingKind;
    /** Which bind group: "mesh" (group 1) or "shadow" (group 2). Default: "mesh" */
    readonly group?: "mesh" | "shadow";
    /** Shader stage visibility flags (e.g. GPUShaderStage.FRAGMENT) */
    readonly visibility: GPUShaderStageFlags;
}

// ── Fragment slots ──────────────────────────────────────────────

/**
 * Named injection points in the fragment shader.
 *
 * Mapping from current PBR hooks:
 *   HOOK_HELPERS        → HF
 *   HOOK_SV     → SV
 *   HOOK_MF      → MF
 *   HOOK_AFTER_DIRECT   → AD
 *   HOOK_NO_LIGHT_VARS  → BL
 *   HOOK_AI      → AI
 *   HOOK_NI  → NI
 */
export type FragmentSlot = "HF" | "SV" | "AT" | "AC" | "MF" | "BL" | "AD" | "AI" | "NI" | "BC" | "BA";

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
    /** Unique ID for dedup and dependency resolution (e.g. "clearcoat", "skeleton") */
    readonly id: string;

    /** Fragment IDs that must be composed before this one */
    readonly dependencies?: readonly string[];

    // ── Vertex stage ──

    /** Extra vertex input attributes */
    readonly vertexAttributes?: readonly VertexAttribute[];

    /** Extra vertex→fragment varyings */
    readonly varyings?: readonly Varying[];

    /** Extra @group(1) bindings used in the vertex shader (skeleton bone tex, morph tex+uniforms) */
    readonly vertexBindings?: readonly BindingDecl[];

    /** WGSL code injected at named vertex slots */
    readonly vertexSlots?: Partial<Record<VertexSlot, string>>;

    /** Extra pipeline vertex buffer layouts (skeleton joints/weights).
     *  Called with next available shader location. Returns layouts + next location. */
    readonly pipelineVertexBuffers?: (nextLoc: number) => { buffers: GPUVertexBufferLayout[]; nextLoc: number };

    /** @builtin declarations for vertex function params (e.g. vertex_index for morph targets) */
    readonly vertexBuiltins?: readonly { readonly name: string; readonly builtin: string; readonly type: string }[];

    /** WGSL helper functions / struct definitions injected before @vertex fn main */
    readonly vertexHelperFunctions?: string;

    // ── Fragment stage ──

    /** UBO fields appended to MeshUniforms (mesh bind group) */
    readonly uboFields?: readonly UboField[];

    /** Extra bindings (textures, samplers) in the fragment shader */
    readonly bindings?: readonly BindingDecl[];

    /** WGSL helper functions injected before @fragment fn main */
    readonly helperFunctions?: string;

    /** Code injected at named fragment slots */
    readonly fragmentSlots?: Partial<Record<FragmentSlot, string>>;

    // ── Scene UBO ──

    /** Fields appended to SceneUniforms (e.g. SH coefficients for IBL) */
    readonly sceneUboFields?: readonly UboField[];
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
    /** Base vertex shader WGSL with slot markers */
    readonly vertexTemplate: string;
    /** Base fragment shader WGSL with slot markers */
    readonly fragmentTemplate: string;
    /** Base mesh UBO fields (e.g. world matrix for PBR, or mesh+lights+material for Standard) */
    readonly baseMeshUboFields: readonly UboField[];
    /** Base scene UBO fields (e.g. viewProj, cameraPosition) */
    readonly baseSceneUboFields: readonly UboField[];
    /** Base vertex attributes (e.g. position, normal) */
    readonly baseVertexAttributes: readonly VertexAttribute[];
    /** Base varyings (e.g. worldPos, worldNormal, uv) */
    readonly baseVaryings: readonly Varying[];
    /** Base fragment bindings (e.g. baseColor texture for PBR, or diffuse/lights/material for Standard) */
    readonly baseBindings?: readonly BindingDecl[];
    /** Base vertex bindings (UBOs used in the vertex shader beyond mesh UBO) */
    readonly baseVertexBindings?: readonly BindingDecl[];
    /** Base material UBO fields (e.g. reflectance, intensity). When provided,
     *  packed into a separate MaterialUniforms UBO at group 1 binding 1,
     *  and fragment uboFields also target the material UBO instead of mesh UBO. */
    readonly baseMaterialUboFields?: readonly UboField[];
}

// ── Composed output ─────────────────────────────────────────────

/** Computed byte layout for a UBO struct */
export interface UboSpec {
    /** Total byte size (aligned to 16 bytes) */
    readonly totalBytes: number;
    /** Map from field name → byte offset */
    readonly offsets: ReadonlyMap<string, number>;
    /** Generated WGSL struct body (fields only, no `struct Name {}`  wrapper) */
    readonly structBody: string;
}

/** The output of composeShader() — everything needed to create a GPU pipeline */
export interface ComposedShader {
    /** Final vertex WGSL source */
    readonly vertexWGSL: string;
    /** Final fragment WGSL source */
    readonly fragmentWGSL: string;
    /** Mesh bind group layout descriptor (group 1) */
    readonly meshBGLDescriptor: GPUBindGroupLayoutDescriptor;
    /** Shadow bind group layout descriptor (group 2), or null */
    readonly shadowBGLDescriptor: GPUBindGroupLayoutDescriptor | null;
    /** Vertex buffer layouts for pipeline descriptor */
    readonly vertexBufferLayouts: GPUVertexBufferLayout[];
    /** Mesh UBO spec */
    readonly meshUboSpec: UboSpec;
    /** Material UBO spec (present when template provides baseMaterialUboFields) */
    readonly materialUboSpec?: UboSpec;
    /** Scene UBO spec */
    readonly sceneUboSpec: UboSpec;
    /** Sorted fragment IDs joined with "|" — used as part of pipeline cache key */
    readonly fragmentKey: string;
    /** Per-fragment UBO pack info: fragment ID → float offset in mesh UBO */
    readonly fragmentUboOffsets: ReadonlyMap<string, number>;
    /** Per-fragment binding info: fragment ID → starting binding index in group 1 */
    readonly fragmentBindingOffsets: ReadonlyMap<string, number>;
}
