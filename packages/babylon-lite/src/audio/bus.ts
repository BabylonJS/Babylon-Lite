/**
 * Main output + main bus.
 *
 * Faithful port of AudioV2 `_WebAudioMainOut` and `_WebAudioMainBus` collapsed
 * to pure state + functions. Graph (Phase 1):
 *
 * `mainBus._volume (GainNode)` -\> `mainOut._gain (GainNode)` -\> `ctx.destination`
 *
 * Sounds connect their sub-graph output into `mainBus._in`.
 */

import { type RampClock, type RampOptions, type RampParam, createRampParam, setRampTarget } from "./audio-param.js";

/** Engine master output node. @internal */
export interface MainOut {
    /** @internal */ _gain: GainNode;
    /** @internal */ _volumeRamp: RampParam;
}

/** A main audio bus. Sounds route here by default. Pure state — drive it with the bus functions. */
export interface MainBus {
    /** Bus name. */
    readonly name: string;

    /** @internal */ _volume: GainNode;
    /** @internal */ _volumeRamp: RampParam;
    /** Input node where upstream sounds/buses connect. @internal */ _in: AudioNode;
    /** Output node feeding the main out. @internal */ _out: AudioNode;
}

/** @internal */
export function createMainOut(ctx: BaseAudioContext, clock: RampClock): MainOut {
    const gain = new GainNode(ctx);
    gain.connect(ctx.destination);
    return { _gain: gain, _volumeRamp: createRampParam(gain.gain, clock) };
}

/** @internal */
export function setMainOutVolume(mainOut: MainOut, value: number, options?: RampOptions): void {
    setRampTarget(mainOut._volumeRamp, value, options);
}

/** @internal */
export function disposeMainOut(mainOut: MainOut): void {
    mainOut._gain.disconnect();
}

/** @internal */
export function createMainBus(name: string, ctx: BaseAudioContext, clock: RampClock, mainOut: MainOut): MainBus {
    const volume = new GainNode(ctx);
    volume.connect(mainOut._gain);
    return {
        name,
        _volume: volume,
        _volumeRamp: createRampParam(volume.gain, clock),
        _in: volume,
        _out: volume,
    };
}

/** @internal */
export function setMainBusVolume(bus: MainBus, value: number, options?: RampOptions): void {
    setRampTarget(bus._volumeRamp, value, options);
}

/** @internal */
export function disposeMainBus(bus: MainBus): void {
    bus._volume.disconnect();
}
