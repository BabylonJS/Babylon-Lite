/**
 * Shared host types for the opt-in audio feature modules (spatial, stereo,
 * analyzer). A "host" is any sound or bus that carries a {@link SoundSubGraph}.
 *
 * Public feature functions accept the concrete public union {@link AudioGraphHost}
 * (so api-extractor never has to roll an internal structural type into the
 * public surface); the internal sub-node builders take the structural
 * {@link AudioGraphHostState} via the union's `@internal` members.
 */

import type { AudioEngine } from "./audio-engine.js";
import type { SoundSubGraph } from "./sound-sub-graph.js";
import type { StaticSound } from "./static-sound.js";
import type { StreamingSound } from "./streaming-sound.js";
import type { AudioBus } from "./audio-bus.js";
import type { AudioInputSource } from "./sound-source.js";

/** A sound, source, or bus that can carry spatial, stereo, or analyzer sub-nodes. */
export type AudioGraphHost = StaticSound | StreamingSound | AudioBus | AudioInputSource;

/** Structural view of a host's engine + sub-graph, used by feature builders. @internal */
export interface AudioGraphHostState {
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _graph: SoundSubGraph;
    /** Live playing instances (sounds only; buses have none). @internal */ _instances?: Set<{ _volumeNode: AudioNode }>;
}
