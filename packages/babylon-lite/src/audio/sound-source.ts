/**
 * Live / external audio input sources — opt-in feature module.
 *
 * Faithful port of AudioV2 `AbstractSoundSource` / `_WebAudioSoundSource`
 * (`createMicrophoneSoundSourceAsync` + `createSoundSourceAsync`), re-architected
 * to Lite idioms (pure state + standalone functions). A source wraps an
 * arbitrary Web Audio `AudioNode` (typically a `MediaStreamAudioSourceNode` from
 * the microphone) and routes it through a {@link SoundSubGraph}, so the spatial,
 * stereo, and analyzer features apply to it exactly as they do to sounds.
 *
 * Signal flow:
 * `sourceNode` -\> `graph._in` -\> (spatial/stereo) -\> `graph._volume` -\> `outBus`
 *
 * The wrapped node is tracked as a single pseudo-instance so the shared
 * {@link rebuildSoundSubGraphHead} logic reconnects it when spatial/stereo are
 * enabled after creation.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type PrimaryAudioBus, getBusInputNode } from "./audio-bus.js";
import { type RampOptions } from "./audio-param.js";
import { type SoundSubGraph, connectSoundSubGraph, createSoundSubGraph, disposeSoundSubGraph, setSoundSubGraphVolume } from "./sound-sub-graph.js";

/** Options for {@link createSoundSourceAsync} and {@link createMicrophoneSoundSourceAsync}. */
export interface SoundSourceOptions {
    /** Optional name. */
    name?: string;
    /** Output bus. Defaults to the engine's main bus unless {@link outBusAutoDefault} is `false`. */
    outBus?: PrimaryAudioBus;
    /**
     * Whether the output bus defaults to the engine's main bus when {@link outBus}
     * is not set. Defaults to `true` for {@link createSoundSourceAsync} and `false`
     * for {@link createMicrophoneSoundSourceAsync} (a mic is usually analyzed, not
     * played back, to avoid feedback).
     */
    outBusAutoDefault?: boolean;
    /** Initial volume. Defaults to `1`. */
    volume?: number;
}

/**
 * A sound fed by a live or external Web Audio input node (e.g. a microphone).
 * Accepted anywhere an {@link AudioGraphHost} is — enable spatial, stereo, or
 * analyzer features on it directly.
 */
export interface AudioInputSource {
    /** The source name. */
    readonly name: string;
    /** @internal */ _engine: AudioEngine;
    /** The wrapped input node; `null` after disposal. @internal */ _node: AudioNode | null;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _outBus: PrimaryAudioBus | null;
    /** Single pseudo-instance wrapping the input node, for head reconnection. @internal */ _instances: Set<{ _volumeNode: AudioNode }>;
    /** @internal */ _dispose(): void;
}

/**
 * Wraps an arbitrary Web Audio node as a sound source, routed to the given
 * output bus (or the engine's default main bus).
 * @param engine - The audio engine.
 * @param node - The input node to wrap (its output is routed through the graph).
 * @param options - Source options.
 * @returns A promise that resolves with the ready source.
 */
export async function createSoundSourceAsync(engine: AudioEngine, node: AudioNode, options: SoundSourceOptions = {}): Promise<AudioInputSource> {
    const graph = createSoundSubGraph(engine._ctx, engine, options.volume ?? 1);

    let outBus: PrimaryAudioBus | null = null;
    if (options.outBus) {
        outBus = options.outBus;
    } else if (options.outBusAutoDefault !== false) {
        outBus = engine._mainBus;
    }
    if (outBus) {
        connectSoundSubGraph(graph, getBusInputNode(outBus));
    }

    node.connect(graph._in);

    const source: AudioInputSource = {
        name: options.name ?? "",
        _engine: engine,
        _node: node,
        _graph: graph,
        _outBus: outBus,
        _instances: new Set([{ _volumeNode: node }]),
        _dispose: () => disposeSoundSource(source),
    };

    engine._sounds.add(source);
    return source;
}

/**
 * Requests microphone access and wraps the resulting stream as a sound source.
 * The source does not auto-connect to the main bus by default (to avoid
 * feedback); attach an analyzer or set an `outBus` to use it.
 * @param engine - The audio engine.
 * @param options - Source options.
 * @returns A promise that resolves with the ready microphone source.
 * @throws If microphone access is denied or unavailable.
 */
export async function createMicrophoneSoundSourceAsync(engine: AudioEngine, options: SoundSourceOptions = {}): Promise<AudioInputSource> {
    let mediaStream: MediaStream;
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        throw new Error("Unable to access microphone: " + String(e), { cause: e });
    }

    const node = new MediaStreamAudioSourceNode(engine._ctx as AudioContext, { mediaStream });
    return createSoundSourceAsync(engine, node, { outBusAutoDefault: false, ...options });
}

/**
 * Sets the source volume, optionally ramping.
 * @param source - The sound source.
 * @param value - Linear gain (`1` = unity).
 * @param options - Optional ramp options.
 */
export function setSoundSourceVolume(source: AudioInputSource, value: number, options?: RampOptions): void {
    setSoundSubGraphVolume(source._graph, value, options);
}

/**
 * Disposes a sound source, stopping any microphone tracks and releasing its
 * graph.
 * @param source - The sound source.
 */
export function disposeSoundSource(source: AudioInputSource): void {
    const node = source._node;
    if (node) {
        if (typeof MediaStreamAudioSourceNode !== "undefined" && node instanceof MediaStreamAudioSourceNode) {
            for (const track of node.mediaStream.getTracks()) {
                track.stop();
            }
        }
        node.disconnect();
        source._node = null;
    }
    disposeSoundSubGraph(source._graph);
    source._engine._sounds.delete(source);
}
