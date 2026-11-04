import { describe, expect, it } from "vitest";

interface TrackMaterialTestModule {
    createTrackUploadViews(frameData: Float32Array, infoData: Float32Array, csmData: Float32Array): readonly [Uint8Array, Uint8Array, Uint8Array];
}

const trackMaterialModule = "../../../lab/lite/src/demos/antigravity-racer/track-material.js";
const { createTrackUploadViews } = (await import(trackMaterialModule)) as TrackMaterialTestModule;

describe("antigravity racer track material uploads", () => {
    it("creates persistent byte views over the mutable float payloads", () => {
        const frameData = new Float32Array(16);
        const infoData = new Float32Array(8);
        const csmData = new Float32Array(80);
        const views = createTrackUploadViews(frameData, infoData, csmData);

        expect(views.map((view) => view.buffer)).toEqual([frameData.buffer, infoData.buffer, csmData.buffer]);
        expect(views.map((view) => view.byteLength)).toEqual([frameData.byteLength, infoData.byteLength, csmData.byteLength]);

        frameData[0] = 1;
        expect(new Float32Array(views[0].buffer, views[0].byteOffset, views[0].byteLength / Float32Array.BYTES_PER_ELEMENT)[0]).toBe(1);
    });
});
