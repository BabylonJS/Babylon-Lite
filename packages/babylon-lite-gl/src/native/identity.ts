/** Keeps native resources distinct across backends and resource kinds in published declarations. */
export declare const nativeResource: unique symbol;

/** The kinds of resource the native backend creates. */
export type NativeResourceKind = "engine" | "effect" | "texture" | "renderTarget" | "vertexBuffer" | "indexBuffer" | "meshVao";

/** Marks a type as the native resource of one kind. */
export interface NativeResource<Kind extends NativeResourceKind> {
    /** Distinguishes native resources by backend and kind; never present at runtime. */
    readonly [nativeResource]: Kind;
}

/** A native resource's fields as its creator builds them, without the type-only identity. */
export type NativeResourceFields<T> = Omit<T, typeof nativeResource>;
