/**
 * Audio demo — Tier-4 interactive showcase (manual, non-deterministic, never a
 * CI gate). Demonstrates the ported AudioV2 surface end to end: engine unlock,
 * a looping synthesized tone (StaticSound), a live microphone input source, and
 * the real-time frequency-bar + waveform visualizer.
 *
 * Requires a user gesture to unlock the audio context — every action is wired to
 * a button click.
 */

import {
    createAudioEngineAsync,
    unlockAudioEngineAsync,
    createUnmuteUI,
    createSoundAsync,
    playSound,
    stopSound,
    createMicrophoneSoundSourceAsync,
    disposeSoundSource,
    createAudioVisualizer,
    startAudioVisualizer,
    stopAudioVisualizer,
    type AudioVisualizer,
    type StaticSound,
    type AudioInputSource,
} from "babylon-lite";

const canvas = document.getElementById("viz") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const toneButton = document.getElementById("tone") as HTMLButtonElement;
const micButton = document.getElementById("mic") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;

function setStatus(text: string): void {
    status.textContent = text;
}

/** Builds a one-second mono 440 Hz sine buffer (A4) for the tone demo. */
function makeToneBuffer(): AudioBuffer {
    const sampleRate = 44100;
    const buffer = new AudioBuffer({ length: sampleRate, sampleRate, numberOfChannels: 1 });
    const data = buffer.getChannelData(0);
    const frequency = 440;
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5;
    }
    return buffer;
}

async function main(): Promise<void> {
    const engine = await createAudioEngineAsync();
    createUnmuteUI(engine);

    let visualizer: AudioVisualizer | null = null;
    let tone: StaticSound | null = null;
    let mic: AudioInputSource | null = null;

    function stopEverything(): void {
        if (visualizer) {
            stopAudioVisualizer(visualizer);
            visualizer = null;
        }
        if (tone) {
            stopSound(tone);
            tone = null;
        }
        if (mic) {
            disposeSoundSource(mic);
            mic = null;
        }
    }

    toneButton.addEventListener("click", async () => {
        stopEverything();
        await unlockAudioEngineAsync(engine);
        tone = await createSoundAsync(engine, makeToneBuffer(), { loop: true, volume: 0.3 });
        visualizer = createAudioVisualizer(tone, canvas, { mode: "both" });
        startAudioVisualizer(visualizer);
        playSound(tone);
        setStatus("Playing a looping 440 Hz tone — watch the bars and waveform.");
    });

    micButton.addEventListener("click", async () => {
        stopEverything();
        await unlockAudioEngineAsync(engine);
        try {
            mic = await createMicrophoneSoundSourceAsync(engine);
        } catch (e) {
            setStatus("Microphone unavailable: " + String(e));
            return;
        }
        visualizer = createAudioVisualizer(mic, canvas, { mode: "both" });
        startAudioVisualizer(visualizer);
        setStatus("Visualizing your microphone (not played back, to avoid feedback).");
    });

    stopButton.addEventListener("click", () => {
        stopEverything();
        setStatus("Stopped.");
    });

    setStatus("Ready — click a button to start (a user gesture unlocks audio).");
}

void main();
