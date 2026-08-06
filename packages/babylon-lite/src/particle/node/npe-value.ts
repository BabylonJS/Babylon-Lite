/**
 * Per-particle value and step types for the data-oriented particle runtime.
 *
 * A "value" in the node graph is read per particle by index. Scalars return a number; vectors and colours
 * return a reused scratch object (never a fresh allocation), so consumers must copy the result immediately.
 * This keeps the value graph allocation-free without giving up its generality.
 */
import type { Vec2, Vec3, Color4 } from "../../math/types.js";

/** CPU-readable RGBA texture content used by texture-driven particle updates. */
export interface NpeTextureContent {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

/** Static texture source passed between texture-valued NPE blocks. */
export interface NpeTextureValue {
    readonly url: string;
    readonly invertY: boolean;
    /** @internal Lazily populated only when a CPU texture consumer is present. */
    _content?: Promise<NpeTextureContent | null>;
}

/** Scalar, vector, or colour value used by arithmetic particle blocks. */
export type NpeValue = number | Vec3 | Color4 | Vec2;

/** Any value that can flow along a node-particle connection. */
export type NpeGraphValue = NpeValue | NpeTextureValue;

/**
 * Reads a value for particle `i`. Scalars return a number; vectors and colours return a REUSED scratch
 * object (never a fresh allocation), so consumers must copy the result immediately. This keeps the value
 * graph allocation-free without giving up its generality.
 */
export type NpeGetter<T extends NpeGraphValue = NpeValue> = (i: number) => T;

/** Reads a scalar value for particle `i`. */
export type ScalarGetter = (i: number) => number;
/** Reads a vector value for particle `i`; the returned {@link Vec3} is a reused scratch — copy on read. */
export type Vec3Getter = (i: number) => Vec3;
/** Reads a colour value for particle `i`; the returned {@link Color4} is a reused scratch — copy on read. */
export type Color4Getter = (i: number) => Color4;

/** A per-particle step (creation or update): reads and writes the buffer's columns for particle `i`. */
export type ParticleStep = (i: number) => void;
