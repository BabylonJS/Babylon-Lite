import { buildNodeParticleSet } from "./npe-build.js";

/**
 * Build an NPE set with both flow-map and noise-texture updates.
 * @deprecated Texture-update blocks now load from the graph; use {@link buildNodeParticleSet}.
 */
export const buildNodeParticleSetWithTextureUpdates = buildNodeParticleSet;
