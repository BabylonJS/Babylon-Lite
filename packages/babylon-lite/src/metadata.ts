/** glTF-specific metadata exposed on Lite scene objects. */
export interface GltfMetadata {
    /** Raw glTF `extras` payload for the source object, when present. */
    extras?: unknown;
}

/** User metadata bag shared by public Lite objects. */
export interface LiteMetadata {
    gltf?: GltfMetadata;
    [key: string]: unknown;
}
