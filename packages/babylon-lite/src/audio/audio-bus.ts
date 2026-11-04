/**
 * Generic audio bus (mixer node).
 *
 * Faithful port of AudioV2 `AudioBus` / `_WebAudioBus`, collapsed to pure state
 * + standalone functions. A bus owns a `SoundSubGraph` (Phase 2: a single
 * volume `GainNode`) and routes its output into another bus (`outBus`), forming
 * a mixer tree that ultimately reaches the engine main bus, main out, and the
 * context destination.
 *
 * Signal flow: `upstream` becomes `bus._graph._in` then `bus._graph._out` then
 * the `outBus` input node, and so on up to `mainOut` then `ctx.destination`.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type RampOptions } from "./audio-param.js";
import { type MainBus, setMainBusVolume } from "./bus.js";
import { type SoundSubGraph, connectSoundSubGraph, createSoundSubGraph, disposeSoundSubGraph, setSoundSubGraphVolume } from "./sound-sub-graph.js";

/** A bus that sounds or other buses can output to (the engine main bus or a generic {@link AudioBus}). */
export type PrimaryAudioBus = AudioBus | MainBus;

/** Options for {@link createAudioBusAsync}. */
export interface AudioBusOptions {
    /** Initial volume. Defaults to `1`. */
    volume?: number;
    /** Output bus. Defaults to the engine's default main bus. */
    outBus?: PrimaryAudioBus;
}

/** A generic mixer bus. Pure state — drive it with the bus functions. */
export interface AudioBus {
    /** Bus name. */
    readonly name: string;

    /** @internal */ _engine: AudioEngine;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _outBus: PrimaryAudioBus;
    /** @internal */ _dispose(): void;
}

/** Narrows a {@link PrimaryAudioBus} to a generic {@link AudioBus}. */
function _isAudioBus(bus: PrimaryAudioBus): bus is AudioBus {
    return "_graph" in bus;
}

/** Resolves the Web Audio input node where upstream sounds/buses connect. @internal */
export function getBusInputNode(bus: PrimaryAudioBus): AudioNode {
    return _isAudioBus(bus) ? bus._graph._in : bus._in;
}

/**
 * Creates a generic mixer bus routed to another bus (defaulting to the engine's
 * default main bus). Multiple sounds/buses can be routed through a bus to mix
 * and control their combined volume.
 * @param engine - The audio engine.
 * @param name - A name for the bus.
 * @param options - Bus options.
 * @returns A promise that resolves with the ready bus.
 */
export async function createAudioBusAsync(engine: AudioEngine, name: string, options: AudioBusOptions = {}): Promise<AudioBus> {
    await engine._isReady;

    const graph = createSoundSubGraph(engine._ctx, engine, options.volume ?? 1);
    const outBus = options.outBus ?? engine._mainBus;
    connectSoundSubGraph(graph, getBusInputNode(outBus));

    const bus: AudioBus = {
        name,
        _engine: engine,
        _graph: graph,
        _outBus: outBus,
        _dispose: () => disposeAudioBus(bus),
    };

    engine._buses.add(bus);
    return bus;
}

/** Sets a bus's output volume, optionally ramping. Works on a generic bus or the main bus. */
export function setBusVolume(bus: PrimaryAudioBus, value: number, options?: RampOptions): void {
    if (_isAudioBus(bus)) {
        setSoundSubGraphVolume(bus._graph, value, options);
    } else {
        setMainBusVolume(bus, value, options);
    }
}

/** Disposes a generic bus, releasing its sub-graph. */
export function disposeAudioBus(bus: AudioBus): void {
    disposeSoundSubGraph(bus._graph);
    bus._engine._buses.delete(bus);
}
