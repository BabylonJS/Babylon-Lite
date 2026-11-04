/**
 * Per-sound sub-graph.
 *
 * Faithful port of AudioV2 `_WebAudioBaseSubGraph` + `_WebAudioBusAndSoundSubGraph`
 * + `_VolumeWebAudioSubNode`. The volume `GainNode` is always present; the
 * spatial, stereo, and analyzer sub-nodes are optional and spliced in on demand
 * by their (tree-shaken) feature modules.
 *
 * Signal flow (mirrors AudioV2 `_onSubNodesChanged`):
 * - none: `instances` -\> `_volume` (`_in` === `_out`)
 * - spatial OR stereo: `instances` -\> `subNode._inputNode` -\> `_volume`
 * - spatial AND stereo: `instances` -\> `_root` (split) -\> [spatial, stereo] -\> `_volume`
 * - analyzer (any of the above): `_volume` also fans out to the analyzer tap
 */

import { type RampClock, type RampOptions, type RampParam, createRampParam, setRampTarget } from "./audio-param.js";

/**
 * Minimal structural view of a pre-volume sub-node (spatial or stereo), kept
 * local so this module does NOT import the feature modules (Pillar 4:
 * tree-shaking) and so the `.d.ts` rollup has no import cycle. The full node
 * (assigned by the feature functions) is structurally compatible. @internal
 */
export interface PreVolumeSlot {
    /** Head input node of the sub-node. @internal */ _inputNode: AudioNode;
    /** @internal */ _dispose(): void;
}

/** Minimal structural view of the analyzer tap sub-node. @internal */
export interface AnalyzerSlot {
    /** @internal */ _dispose(): void;
}

/** Sound sub-graph state. @internal */
export interface SoundSubGraph {
    /** @internal */ _ctx: BaseAudioContext;
    /** @internal */ _volume: GainNode;
    /** @internal */ _volumeRamp: RampParam;
    /** Optional spatial (3D panner) sub-node. @internal */ _spatial: PreVolumeSlot | null;
    /** Optional stereo-pan sub-node. @internal */ _stereo: PreVolumeSlot | null;
    /** Optional analyzer tap off {@link _volume}. @internal */ _analyzer: AnalyzerSlot | null;
    /** Split gain feeding both spatial and stereo when both are present. @internal */ _root: GainNode | null;
    /** Head node — where playing instances connect. @internal */ _in: AudioNode;
    /** Tail node — connects to the output bus. @internal */ _out: AudioNode;
}

/** @internal */
export function createSoundSubGraph(ctx: BaseAudioContext, clock: RampClock, volume = 1): SoundSubGraph {
    const gain = new GainNode(ctx);
    gain.gain.value = volume;
    return {
        _ctx: ctx,
        _volume: gain,
        _volumeRamp: createRampParam(gain.gain, clock),
        _spatial: null,
        _stereo: null,
        _analyzer: null,
        _root: null,
        _in: gain,
        _out: gain,
    };
}

/**
 * Recomputes the head node (`_in`) after a pre-volume sub-node (spatial/stereo)
 * is added or removed, mirroring AudioV2 `_onSubNodesChanged`. When both spatial
 * and stereo are present they run in parallel, fed by a split `_root` gain. Any
 * live instances are reconnected from the old head to the new one. @internal
 */
export function rebuildSoundSubGraphHead(graph: SoundSubGraph, instances?: Iterable<{ _volumeNode: AudioNode }>): void {
    const spatial = graph._spatial;
    const stereo = graph._stereo;

    let head: AudioNode;
    if (spatial && stereo) {
        const root = (graph._root ??= new GainNode(graph._ctx));
        root.disconnect();
        root.connect(spatial._inputNode);
        root.connect(stereo._inputNode);
        head = root;
    } else {
        if (graph._root) {
            graph._root.disconnect();
            graph._root = null;
        }
        head = spatial?._inputNode ?? stereo?._inputNode ?? graph._volume;
    }

    const oldHead = graph._in;
    if (oldHead === head) {
        return;
    }
    graph._in = head;

    if (instances) {
        for (const instance of instances) {
            try {
                instance._volumeNode.disconnect(oldHead);
            } catch {
                // Instance may not yet be connected; ignore.
            }
            instance._volumeNode.connect(head);
        }
    }
}

/** @internal */
export function setSoundSubGraphVolume(graph: SoundSubGraph, value: number, options?: RampOptions): void {
    setRampTarget(graph._volumeRamp, value, options);
}

/** Connects the sub-graph output to a downstream input node. @internal */
export function connectSoundSubGraph(graph: SoundSubGraph, downstream: AudioNode): void {
    graph._out.connect(downstream);
}

/** Disconnects the sub-graph output from a downstream input node. @internal */
export function disconnectSoundSubGraph(graph: SoundSubGraph, downstream: AudioNode): void {
    graph._out.disconnect(downstream);
}

/** @internal */
export function disposeSoundSubGraph(graph: SoundSubGraph): void {
    graph._spatial?._dispose();
    graph._spatial = null;
    graph._stereo?._dispose();
    graph._stereo = null;
    graph._analyzer?._dispose();
    graph._analyzer = null;
    graph._root?.disconnect();
    graph._root = null;
    graph._volume.disconnect();
}
