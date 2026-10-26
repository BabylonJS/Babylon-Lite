/** glTF 2.0 JSON interfaces for the exporter.
 *
 *  The loader types glTF JSON as `any`, so the exporter declares its own schema typings,
 *  covering only the members it writes. Member names and value types follow the glTF 2.0
 *  JSON schema; every member is optional except where the schema requires it. */

/** Free-form extension or extras payload. */
export type GltfJsonObject = Record<string, unknown>;

/** Members every glTF object may carry. */
export interface GltfProperty {
    extensions?: GltfJsonObject;
    extras?: unknown;
}

export interface GltfAsset extends GltfProperty {
    version: "2.0";
    generator?: string;
}

export interface GltfScene extends GltfProperty {
    nodes?: number[];
}

export interface GltfNode extends GltfProperty {
    name?: string;
    camera?: number;
    children?: number[];
    matrix?: number[];
    mesh?: number;
    rotation?: number[];
    scale?: number[];
    translation?: number[];
}

/** Attribute semantic → accessor index. */
export type GltfAttributes = Record<string, number>;

export interface GltfPrimitive extends GltfProperty {
    attributes: GltfAttributes;
    indices?: number;
    material?: number;
    mode?: number;
    targets?: GltfAttributes[];
}

export interface GltfMesh extends GltfProperty {
    name?: string;
    primitives: GltfPrimitive[];
    weights?: number[];
}

export interface GltfTextureInfo extends GltfProperty {
    index: number;
    texCoord?: number;
}

export interface GltfNormalTextureInfo extends GltfTextureInfo {
    scale?: number;
}

export interface GltfOcclusionTextureInfo extends GltfTextureInfo {
    strength?: number;
}

export interface GltfPbrMetallicRoughness extends GltfProperty {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
}

export interface GltfMaterial extends GltfProperty {
    name?: string;
    pbrMetallicRoughness?: GltfPbrMetallicRoughness;
    normalTexture?: GltfNormalTextureInfo;
    occlusionTexture?: GltfOcclusionTextureInfo;
    emissiveTexture?: GltfTextureInfo;
    emissiveFactor?: number[];
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
    doubleSided?: boolean;
}

export interface GltfTexture extends GltfProperty {
    source?: number;
}

export interface GltfImage extends GltfProperty {
    name?: string;
    mimeType?: string;
    bufferView?: number;
}

export interface GltfCameraPerspective extends GltfProperty {
    yfov: number;
    znear: number;
    zfar?: number;
    aspectRatio?: number;
}

export interface GltfCameraOrthographic extends GltfProperty {
    xmag: number;
    ymag: number;
    znear: number;
    zfar: number;
}

export interface GltfCamera extends GltfProperty {
    name?: string;
    type: "perspective" | "orthographic";
    perspective?: GltfCameraPerspective;
    orthographic?: GltfCameraOrthographic;
}

export interface GltfAnimationChannelTarget extends GltfProperty {
    node?: number;
    path: "translation" | "rotation" | "scale" | "weights";
}

export interface GltfAnimationChannel extends GltfProperty {
    sampler: number;
    target: GltfAnimationChannelTarget;
}

export interface GltfAnimationSampler extends GltfProperty {
    input: number;
    output: number;
    interpolation?: "LINEAR" | "STEP" | "CUBICSPLINE";
}

export interface GltfAnimation extends GltfProperty {
    name?: string;
    channels: GltfAnimationChannel[];
    samplers: GltfAnimationSampler[];
}

/** glTF accessor component types: UNSIGNED_SHORT, UNSIGNED_INT, FLOAT. */
export type GltfComponentType = 5123 | 5125 | 5126;

export type GltfAccessorType = "SCALAR" | "VEC2" | "VEC3" | "VEC4";

export interface GltfAccessor extends GltfProperty {
    bufferView?: number;
    componentType: GltfComponentType;
    count: number;
    type: GltfAccessorType;
    max?: number[];
    min?: number[];
}

/** bufferView targets: ARRAY_BUFFER (vertex attributes) and ELEMENT_ARRAY_BUFFER (indices). */
export type GltfBufferViewTarget = 34962 | 34963;

export interface GltfBufferView extends GltfProperty {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    target?: GltfBufferViewTarget;
}

export interface GltfBuffer extends GltfProperty {
    byteLength: number;
}

/** The glTF document root. Empty arrays are never serialized. */
export interface GltfDocument extends GltfProperty {
    asset: GltfAsset;
    extensionsUsed?: string[];
    scene?: number;
    scenes?: GltfScene[];
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    materials?: GltfMaterial[];
    textures?: GltfTexture[];
    images?: GltfImage[];
    cameras?: GltfCamera[];
    animations?: GltfAnimation[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: GltfBuffer[];
}
