import { buildNodeParticleSet } from "./npe-build.js";

/**
 * Build an NPE set with `UpdateFlowMapBlock` support.
 * @deprecated Flow-map blocks now load from the graph; use {@link buildNodeParticleSet}.
 */
export const buildNodeParticleSetWithFlowMaps = buildNodeParticleSet;
