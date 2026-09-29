import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_AUDIO_PROFILES, disposePlayroomAudio, matchContactAudio, relativeCollisionMetrics, startPlayroomAudioLoad } from "../../../lab/lite/src/demos/playroom/audio.js";
import type { BodyRecord } from "../../../lab/lite/src/demos/playroom/types.js";

const audioApi = {
    createAudioEngineAsync: vi.fn<() => Promise<unknown>>(),
    createSoundSourceAsync: vi.fn<() => Promise<unknown>>(),
    disposeAudioEngine: vi.fn(),
    disposeSoundSource: vi.fn(),
    unlockAudioEngineAsync: vi.fn<() => Promise<void>>(),
};
const startPlayroomAudioLoadWithApi = startPlayroomAudioLoad as unknown as (urlFor: (file: string) => string, api: typeof audioApi) => ReturnType<typeof startPlayroomAudioLoad>;

function record(id: number, audioTags: readonly string[]): BodyRecord {
    return { id, audioTags } as BodyRecord;
}

describe("The Playroom collision audio", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("disposes an engine that resolves after the Playroom audio state was disposed", async () => {
        let resolveEngine!: (engine: unknown) => void;
        audioApi.createAudioEngineAsync.mockReturnValue(
            new Promise((resolve) => {
                resolveEngine = resolve;
            })
        );
        const gain = { gain: { value: 0 }, disconnect: vi.fn() };
        const engine = { audioContext: { createGain: vi.fn(() => gain) } };
        const load = startPlayroomAudioLoadWithApi((file) => file, audioApi);
        expect(audioApi.createAudioEngineAsync).toHaveBeenCalledOnce();

        disposePlayroomAudio(load.state);
        resolveEngine(engine);
        await load.ready;

        expect(audioApi.disposeAudioEngine).toHaveBeenCalledOnce();
        expect(audioApi.disposeAudioEngine).toHaveBeenCalledWith(engine);
        expect(audioApi.createSoundSourceAsync).not.toHaveBeenCalled();
        expect(load.state).toMatchObject({ disposed: true, status: "unavailable", engine: null, context: null, master: null, route: null });
        expect(load.state.buffers.size).toBe(0);
    });

    it("releases attached audio ownership and cannot become ready when decoding finishes after disposal", async () => {
        let resolveDecode!: (buffer: AudioBuffer) => void;
        let notifyDecodeStarted!: () => void;
        const decodeStarted = new Promise<void>((resolve) => {
            notifyDecodeStarted = resolve;
        });
        const decode = new Promise<AudioBuffer>((resolve) => {
            resolveDecode = resolve;
        });
        const gain = { gain: { value: 0 }, disconnect: vi.fn() };
        const context = {
            createGain: vi.fn(() => gain),
            decodeAudioData: vi.fn(() => {
                notifyDecodeStarted();
                return decode;
            }),
        };
        const engine = { audioContext: context };
        const route = {};
        audioApi.createAudioEngineAsync.mockResolvedValue(engine);
        audioApi.createSoundSourceAsync.mockResolvedValue(route);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(1),
        }));
        vi.stubGlobal("fetch", fetchMock);

        const load = startPlayroomAudioLoadWithApi((file) => file, audioApi);
        expect(audioApi.createAudioEngineAsync).toHaveBeenCalledOnce();
        await decodeStarted;
        disposePlayroomAudio(load.state);

        expect(audioApi.disposeSoundSource).toHaveBeenCalledWith(route);
        expect(audioApi.disposeAudioEngine).toHaveBeenCalledWith(engine);
        expect(load.state).toMatchObject({ disposed: true, status: "unavailable", engine: null, context: null, master: null, route: null });

        resolveDecode({} as AudioBuffer);
        await load.ready;
        expect(load.state.status).toBe("unavailable");
        expect(load.state.buffers.size).toBe(0);
    });

    it("uses indexed relative squared speed so co-moving bodies are silent", () => {
        expect(relativeCollisionMetrics({ x: 3, y: -2, z: 1 }, { x: 3, y: -2, z: 1 })).toEqual({ speedSquared: 0, verticalSpeed: 2 });
        expect(relativeCollisionMetrics({ x: 3, y: -2, z: 1 }, { x: 1, y: 1, z: 5 })).toEqual({ speedSquared: 29, verticalSpeed: 2 });
    });

    it("matches both participant orientations and preserves the selected instance indices", () => {
        const ground = record(1, ["soft", "ground"]);
        const projectile = record(2, ["soft", "projectile"]);
        const forward = matchContactAudio(projectile, 7, ground, 0).find((match) => match.profile.name === "projectile-ground")!;
        const reverse = matchContactAudio(ground, 0, projectile, 7).find((match) => match.profile.name === "projectile-ground")!;
        expect(forward.colliderIndex).toBe(7);
        expect(reverse.colliderIndex).toBe(7);
        expect(reverse.collideeIndex).toBe(0);
    });

    it("rewrites caller-owned match storage without replacing matched records", () => {
        const ground = record(1, ["soft", "ground"]);
        const projectile = record(2, ["soft", "projectile"]);
        const matches = matchContactAudio(projectile, 7, ground, 0);
        const projectileGround = matches.find((match) => match.profile.name === "projectile-ground")!;

        const reused = matchContactAudio(ground, 2, projectile, 9, matches);

        expect(reused).toBe(matches);
        expect(reused.find((match) => match.profile.name === "projectile-ground")).toBe(projectileGround);
        expect(projectileGround).toMatchObject({ collider: projectile, colliderIndex: 9, collidee: ground, collideeIndex: 2 });
    });

    it("keeps distinct source category pools and thresholds", () => {
        const names = CONTACT_AUDIO_PROFILES.map((profile) => profile.name);
        expect(names).toEqual([
            "bowling-ball-ground",
            "bowling-pin-hard",
            "bowling-pin-soft",
            "domino-hard",
            "plastic-block-hard",
            "plastic-block-soft",
            "plastic-cup-hard",
            "plastic-cup-soft",
            "chess-piece-hard",
            "chess-piece-soft",
            "chess-board-hard",
            "wood-block-hard",
            "wood-block-soft",
            "projectile-ground",
        ]);
        expect(CONTACT_AUDIO_PROFILES.find((profile) => profile.name === "domino-hard")).toMatchObject({
            files: Array(8).fill("domino.mp3"),
            velocityThreshold: 0.1,
            minTimeBetweenPlaysMs: 20,
        });
        expect(CONTACT_AUDIO_PROFILES.find((profile) => profile.name === "plastic-cup-soft")).toMatchObject({
            files: ["plastic-cup-soft-1.mp3"],
            velocityThreshold: 50,
            velocityThresholdForGround: 1,
        });
    });
});
