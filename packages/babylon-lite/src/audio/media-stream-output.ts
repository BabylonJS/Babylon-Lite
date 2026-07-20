/**
 * Media-stream output — opt-in tap of the audio engine's final master mix.
 *
 * The tap mirrors the post-master signal into a MediaStream without changing
 * the normal speaker output. Consumers can use that stream for recording,
 * WebRTC, or other browser media pipelines, then dispose the tap independently.
 */

import type { AudioEngine } from "./audio-engine.js";

/** Pure-state handle for a MediaStream carrying the audio engine's final master mix. */
export interface AudioEngineMediaStream {
    /** One live audio track containing the post-master engine output. */
    readonly stream: MediaStream;
    /** @internal */ readonly _engine: AudioEngine;
    /** @internal */ readonly _source: GainNode;
    /** @internal */ readonly _destination: MediaStreamAudioDestinationNode;
    /** @internal */ readonly _engineDisposer: () => void;
    /** @internal */ _registered: boolean;
    /** @internal */ _disposed: boolean;
    /** @internal */ _dispose(): void;
}

/**
 * Mirrors an engine's final master output into a MediaStream.
 *
 * Real-time Web Audio is required because OfflineAudioContext has no
 * MediaStream destination. The engine's audible destination remains connected.
 */
export function createAudioEngineMediaStream(engine: AudioEngine): AudioEngineMediaStream {
    const context = engine._ctx;
    if (engine._isOffline || typeof (context as AudioContext).createMediaStreamDestination !== "function") {
        throw new Error("Audio engine media streams require a real-time AudioContext.");
    }

    const source = engine._mainOut._gain;
    const destination = (context as AudioContext).createMediaStreamDestination();
    source.connect(destination);

    const output: AudioEngineMediaStream = {
        stream: destination.stream,
        _engine: engine,
        _source: source,
        _destination: destination,
        _engineDisposer: () => {
            output._registered = false;
            disposeAudioEngineMediaStream(output);
        },
        _registered: true,
        _disposed: false,
        _dispose: () => disposeAudioEngineMediaStream(output),
    };

    engine._disposers.push(output._engineDisposer);
    return output;
}

/**
 * Disconnects a media-stream tap and stops every track owned by its stream.
 * Safe to call more than once.
 */
export function disposeAudioEngineMediaStream(output: AudioEngineMediaStream): void {
    if (output._disposed) {
        return;
    }

    output._disposed = true;
    if (output._registered) {
        output._registered = false;
        const disposerIndex = output._engine._disposers.indexOf(output._engineDisposer);
        if (disposerIndex !== -1) {
            output._engine._disposers.splice(disposerIndex, 1);
        }
    }
    output._source.disconnect(output._destination);
    for (const track of output.stream.getTracks()) {
        track.stop();
    }
}
