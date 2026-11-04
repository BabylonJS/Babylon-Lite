/**
 * Decoded audio buffer.
 *
 * Faithful port of AudioV2 `_WebAudioStaticSoundBuffer` — collapsed to pure
 * state + a `createSoundBufferAsync` factory. Source may be an `AudioBuffer`, a
 * raw `ArrayBuffer`, a single URL, or an array of URLs (first decodable wins).
 */

import { type AudioEngine, isAudioFormatValid } from "./audio-engine.js";
import { getFileExtension, loadAudioArrayBuffer } from "./audio-fetch.js";

/** A decoded audio buffer ready to be played by one or more sounds. */
export interface SoundBuffer {
    /** The underlying Web Audio buffer. @internal */
    _audioBuffer: AudioBuffer;
    /** Duration in seconds. */
    readonly duration: number;
    /** Sample rate in Hz. */
    readonly sampleRate: number;
    /** Number of channels. */
    readonly channelCount: number;
    /** Length in samples. */
    readonly length: number;
}

/** Source accepted when creating a sound or sound buffer. */
export type SoundSource = ArrayBuffer | AudioBuffer | SoundBuffer | string | string[];

/** Options for {@link createSoundBufferAsync}. */
export interface SoundBufferOptions {
    /** Skip the browser codec check when selecting among multiple URLs. */
    skipCodecCheck?: boolean;
}

function wrapAudioBuffer(audioBuffer: AudioBuffer): SoundBuffer {
    return {
        _audioBuffer: audioBuffer,
        get duration() {
            return audioBuffer.duration;
        },
        get sampleRate() {
            return audioBuffer.sampleRate;
        },
        get channelCount() {
            return audioBuffer.numberOfChannels;
        },
        get length() {
            return audioBuffer.length;
        },
    };
}

async function decodeUrl(engine: AudioEngine, url: string): Promise<AudioBuffer> {
    const data = await loadAudioArrayBuffer(url);
    return await engine._ctx.decodeAudioData(data);
}

/**
 * Loads and decodes audio into a reusable {@link SoundBuffer}.
 * @param engine - The audio engine.
 * @param source - An `AudioBuffer`, `ArrayBuffer`, URL, or URL list.
 * @param options - Decode options.
 * @returns A promise that resolves with the decoded buffer.
 */
export async function createSoundBufferAsync(engine: AudioEngine, source: SoundSource, options: SoundBufferOptions = {}): Promise<SoundBuffer> {
    // Already a decoded SoundBuffer?
    if (typeof source === "object" && source !== null && "_audioBuffer" in source) {
        return source;
    }

    if (typeof AudioBuffer !== "undefined" && source instanceof AudioBuffer) {
        return wrapAudioBuffer(source);
    }

    if (source instanceof ArrayBuffer) {
        return wrapAudioBuffer(await engine._ctx.decodeAudioData(source));
    }

    if (typeof source === "string") {
        return wrapAudioBuffer(await decodeUrl(engine, source));
    }

    if (Array.isArray(source)) {
        const skipCodecCheck = options.skipCodecCheck ?? false;
        for (const url of source) {
            const format = getFileExtension(url);
            if (!skipCodecCheck && (!format || !isAudioFormatValid(engine, format))) {
                continue;
            }
            try {
                return wrapAudioBuffer(await decodeUrl(engine, url));
            } catch {
                if (format) {
                    engine._invalidFormats.add(format);
                }
            }
        }
        throw new Error("No decodable audio source found in URL list.");
    }

    // Remaining possibility: an `AudioBuffer` in an environment without the global.
    return wrapAudioBuffer(source as AudioBuffer);
}
