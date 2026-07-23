/**
 * Per-particle value and step types for the data-oriented particle runtime.
 *
 * A "value" in the node graph is read per particle by index. Scalars return a number; vectors and colours
 * return a reused scratch object (never a fresh allocation), so consumers must copy the result immediately.
 * This keeps the value graph allocation-free without giving up its generality.
 */
import type { Vec2, Vec3, Color4 } from "../../math/types.js";

/** Any value that can flow along a node-particle connection in the data-oriented runtime. */
export type SoaValue = number | Vec3 | Color4 | Vec2;

/**
 * Reads a value for particle `i`. Scalars return a number; vectors and colours return a REUSED scratch
 * object (never a fresh allocation), so consumers must copy the result immediately. This keeps the value
 * graph allocation-free without giving up its generality.
 */
export type SoaGetter = (i: number) => SoaValue;

/** Reads a scalar value for particle `i`. */
export type ScalarGetter = (i: number) => number;
/** Reads a vector value for particle `i`; the returned {@link Vec3} is a reused scratch — copy on read. */
export type Vec3Getter = (i: number) => Vec3;
/** Reads a colour value for particle `i`; the returned {@link Color4} is a reused scratch — copy on read. */
export type Color4Getter = (i: number) => Color4;

/** A per-particle step (creation or update): reads and writes the buffer's columns for particle `i`. */
export type ParticleStep = (i: number) => void;
