/**
 * Stereo panning — opt-in feature module.
 *
 * Faithful port of AudioV2 `_StereoAudioSubNode` / `_StereoWebAudioSubNode`,
 * re-architected to Lite idioms (pure state + standalone functions). Building
 * the sub-node is lazy, so importing nothing from here costs nothing.
 *
 * The stereo sub-node wraps a Web Audio `StereoPannerNode`. It is spliced into
 * the host's sub-graph in parallel with the optional spatial sub-node (see
 * {@link rebuildSoundSubGraphHead}); when both are present a split gain feeds
 * both branches, exactly as AudioV2 `_onSubNodesChanged` does.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type RampOptions, type RampParam, createRampParam, setRampTarget } from "./audio-param.js";
import { rebuildSoundSubGraphHead } from "./sound-sub-graph.js";
import { type AudioGraphHost, type AudioGraphHostState } from "./host-types.js";

/** Default stereo pan: centered. */
const DEFAULT_PAN = 0;

/** Options for {@link enableStereo}. */
export interface StereoSoundOptions {
    /** Stereo pan in the range `[-1, 1]` (`-1` = full left, `1` = full right). Defaults to `0`. */
    pan?: number;
}

/** Stereo-pan sub-node state. Pure state — driven by the stereo functions. @internal */
export interface StereoSubNode {
    /** @internal */ _engine: AudioEngine;
    /** Head node — playing instances connect here; also the output to volume. @internal */ _inputNode: StereoPannerNode;
    /** @internal */ _pan: RampParam;
    /** @internal */ _dispose: () => void;
}

function createStereoSubNode(engine: AudioEngine): StereoSubNode {
    const node = new StereoPannerNode(engine._ctx);
    node.pan.value = DEFAULT_PAN;
    return {
        _engine: engine,
        _inputNode: node,
        _pan: createRampParam(node.pan, engine),
        _dispose: () => {
            node.disconnect();
        },
    };
}

/**
 * Lazily build the stereo sub-node and splice it into the host's sub-graph,
 * reconnecting any live instances. Idempotent.
 */
function ensureStereoSubNode(host: AudioGraphHostState): StereoSubNode {
    const graph = host._graph;
    if (graph._stereo) {
        // The graph stores a structural slot; this feature module owns the full node.
        return graph._stereo as StereoSubNode;
    }

    const node = createStereoSubNode(host._engine);
    node._inputNode.connect(graph._volume);
    graph._stereo = node;

    // Recompute the head and reconnect live instances (handles spatial+stereo parallel routing).
    rebuildSoundSubGraphHead(graph, host._instances);

    return node;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Enables (or reconfigures) stereo panning on a sound or bus, building the
 * stereo sub-node on first use. Pulls the stereo module only when called.
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param options - Stereo options (pan).
 */
export function enableStereo(host: AudioGraphHost, options: StereoSoundOptions = {}): void {
    const node = ensureStereoSubNode(host);
    if (options.pan !== undefined) {
        setRampTarget(node._pan, options.pan);
    }
}

/**
 * Sets the stereo pan of a sound or bus, building the stereo sub-node on first
 * use.
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param pan - Pan in the range `[-1, 1]` (`-1` = full left, `1` = full right).
 * @param options - Optional ramp options for a smooth transition.
 */
export function setStereoPan(host: AudioGraphHost, pan: number, options?: RampOptions): void {
    const node = ensureStereoSubNode(host);
    setRampTarget(node._pan, pan, options);
}
