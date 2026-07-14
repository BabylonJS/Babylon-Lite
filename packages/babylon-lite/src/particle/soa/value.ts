/**
 * Per-particle value and step types for the data-oriented particle runtime — SPIKE.
 *
 * A "value" in the node graph is read per particle by index. Scalars return a number; vectors and colours
 * return a REUSED scratch object (never a fresh allocation), so consumers must copy the result immediately
 * — exactly the discipline the object runtime already follows with `copyVec3`/`copyColor4`. This keeps the
 * value graph allocation-free without giving up its generality.
 */
import type { Vec3, Color4 } from "../../math/types.js";

/** Reads a scalar value for particle `i`. */
export type ScalarGetter = (i: number) => number;
/** Reads a vector value for particle `i`; the returned {@link Vec3} is a reused scratch — copy on read. */
export type Vec3Getter = (i: number) => Vec3;
/** Reads a colour value for particle `i`; the returned {@link Color4} is a reused scratch — copy on read. */
export type Color4Getter = (i: number) => Color4;

/** A per-particle step (creation or update): reads and writes the buffer's columns for particle `i`. */
export type ParticleStep = (i: number) => void;
