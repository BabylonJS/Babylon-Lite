/**
 * Babylon Lite audio engine — public surface (engine + static sounds + buses).
 *
 * Side-effect-free re-exports only, so unused audio code is fully tree-shaken.
 */

export { createAudioEngineAsync, disposeAudioEngine, unlockAudioEngineAsync, setMasterVolume, getMasterVolume } from "./audio-engine.js";
export type { AudioEngine, AudioEngineOptions, AudioEngineState } from "./audio-engine.js";

export { createSoundAsync, playSound, pauseSound, resumeSound, stopSound, disposeSound, setSoundVolume, SoundState } from "./static-sound.js";
export type { StaticSound, StaticSoundOptions, StaticSoundPlayOptions, StaticSoundStopOptions } from "./static-sound.js";

export {
    createStreamingSoundAsync,
    preloadStreamingInstanceAsync,
    preloadStreamingInstancesAsync,
    playStreamingSound,
    pauseStreamingSound,
    resumeStreamingSound,
    stopStreamingSound,
    disposeStreamingSound,
    setStreamingSoundVolume,
} from "./streaming-sound.js";
export type { StreamingSound, StreamingSoundOptions, StreamingSoundPlayOptions, StreamingSoundSource } from "./streaming-sound.js";

export { createAudioBusAsync, disposeAudioBus, setBusVolume } from "./audio-bus.js";
export type { AudioBus, AudioBusOptions, PrimaryAudioBus } from "./audio-bus.js";
export type { MainBus } from "./bus.js";

export {
    enableSpatial,
    setSpatialPosition,
    setSpatialOrientation,
    attachSpatialTarget,
    detachSpatialTarget,
    setSpatialListener,
    setSpatialListenerPosition,
    updateSpatialAudio,
    setSpatialAutoUpdate,
} from "./spatial.js";
export type { SpatialSoundOptions, SpatialListenerOptions, SpatialTarget, SpatialAttachmentType } from "./spatial.js";

export { enableStereo, setStereoPan } from "./stereo.js";
export type { StereoSoundOptions } from "./stereo.js";

export { enableAnalyzer, getByteFrequencyData, getFloatFrequencyData, getByteTimeDomainData, getFloatTimeDomainData } from "./analyzer.js";
export type { AudioAnalyzerOptions } from "./analyzer.js";

export type { AudioGraphHost } from "./host-types.js";

export { createSoundSourceAsync, createMicrophoneSoundSourceAsync, setSoundSourceVolume, disposeSoundSource } from "./sound-source.js";
export type { AudioInputSource, SoundSourceOptions } from "./sound-source.js";

export { createUnmuteUI, setUnmuteUIEnabled, disposeUnmuteUI } from "./unmute-ui.js";
export type { UnmuteUI, UnmuteUIOptions } from "./unmute-ui.js";

export { createAudioVisualizer, renderAudioVisualizerFrame, startAudioVisualizer, stopAudioVisualizer, disposeAudioVisualizer } from "./visualizer.js";
export type { AudioVisualizer, AudioVisualizerOptions, AudioVisualizerMode } from "./visualizer.js";

export { createSoundBufferAsync } from "./sound-buffer.js";
export type { SoundBuffer, SoundSource, SoundBufferOptions } from "./sound-buffer.js";

export type { AudioSignal } from "./audio-signal.js";
export type { AudioRampShape, RampOptions } from "./audio-param.js";
