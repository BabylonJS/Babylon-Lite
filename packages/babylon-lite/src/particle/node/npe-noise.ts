import { buildNodeParticleSet } from "./npe-build.js";

/**
 * Build an NPE set with `UpdateNoiseBlock` support.
 * @deprecated Noise-texture blocks now load from the graph; use {@link buildNodeParticleSet}.
 */
export const buildNodeParticleSetWithNoiseTextures = buildNodeParticleSet;
