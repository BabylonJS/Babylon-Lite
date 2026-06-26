/**
 * Babylon.js AudioV2 enums and small shared helpers.
 *
 * These mirror the `@babylonjs/core` `AudioV2` `const enum`s exactly (same member
 * names and values) so ported code that reads e.g. `SoundState.Started` or
 * `AudioParameterRampShape.Linear` resolves identically.
 */

import type { RampOptions as LiteRampOptions } from "babylon-lite";

/** Playback state of a sound (mirrors `@babylonjs/core` `SoundState`). */
export const SoundState = {
    Stopping: 0,
    Stopped: 1,
    Starting: 2,
    Started: 3,
    FailedToStart: 4,
    Paused: 5,
} as const;
export type SoundState = (typeof SoundState)[keyof typeof SoundState];

/** Ramp shape used when changing an audio parameter (mirrors `AudioParameterRampShape`). */
export const AudioParameterRampShape = {
    Linear: "linear",
    Exponential: "exponential",
    Logarithmic: "logarithmic",
    None: "none",
} as const;
export type AudioParameterRampShape = (typeof AudioParameterRampShape)[keyof typeof AudioParameterRampShape];

/** Which transform components a spatial sound/listener follows (mirrors `SpatialAudioAttachmentType`). */
export const SpatialAudioAttachmentType = {
    Position: 1,
    Rotation: 2,
    PositionAndRotation: 3,
} as const;
export type SpatialAudioAttachmentType = (typeof SpatialAudioAttachmentType)[keyof typeof SpatialAudioAttachmentType];

/** FFT window sizes accepted by the analyzer (mirrors `AudioAnalyzerFFTSizeType`). */
export type AudioAnalyzerFFTSizeType = 32 | 64 | 128 | 256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768;

/** Engine context state (mirrors `AudioEngineV2State`). */
export type AudioEngineV2State = "closed" | "interrupted" | "running" | "suspended";

/** Babylon.js `IAudioParameterRampOptions`. */
export interface IAudioParameterRampOptions {
    /** Ramp time, in seconds. */
    duration: number;
    /** Ramp shape. */
    shape: AudioParameterRampShape;
}

/**
 * Maps a Babylon.js ramp option bag to the Lite `RampOptions` shape. The shape
 * string values are identical between the two APIs, so this is a structural pass
 * through.
 * @internal
 */
export function toLiteRamp(options?: Partial<IAudioParameterRampOptions> | null): LiteRampOptions | undefined {
    if (!options) {
        return undefined;
    }
    return { duration: options.duration, shape: options.shape };
}
