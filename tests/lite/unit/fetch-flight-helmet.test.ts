import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_HELMET_FILES, fetchFlightHelmet } from "../../../scripts/fetch-flight-helmet";

const mocks = vi.hoisted(() => ({
    exists: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    digest: vi.fn(),
    update: vi.fn(),
}));

vi.mock("node:fs", () => ({
    existsSync: mocks.exists,
    mkdirSync: vi.fn(),
    readFileSync: mocks.read,
    writeFileSync: mocks.write,
    renameSync: mocks.rename,
    rmSync: mocks.remove,
}));

vi.mock("node:crypto", () => ({
    createHash: (algorithm: string) => {
        expect(algorithm).toBe("sha1");
        return {
            update: mocks.update,
            digest: mocks.digest,
        };
    },
}));

beforeEach(() => {
    vi.resetAllMocks();
    mocks.update.mockReturnValue({ update: mocks.update, digest: mocks.digest });
    mocks.exists.mockReturnValue(false);
});

afterEach(() => vi.unstubAllGlobals());

describe("Flight Helmet fixture setup", () => {
    it("reuses every verified cached file without downloading or rewriting", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        mocks.exists.mockReturnValue(true);
        mocks.read.mockReturnValue(bytes);
        for (const [, digest] of FLIGHT_HELMET_FILES) {
            mocks.digest.mockReturnValueOnce(digest);
        }
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await fetchFlightHelmet();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.read).toHaveBeenCalledTimes(17);
        expect(mocks.update).toHaveBeenCalledWith("blob 3\0");
        expect(mocks.update).toHaveBeenCalledWith(bytes);
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("downloads immutable URLs, verifies bytes, then atomically publishes files", async () => {
        // Each batch resolves concurrently, in the order its requests were started.
        for (const [, digest] of FLIGHT_HELMET_FILES) {
            mocks.digest.mockReturnValueOnce(digest);
        }
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
        vi.stubGlobal("fetch", fetchMock);

        await fetchFlightHelmet();

        expect(fetchMock).toHaveBeenCalledTimes(17);
        for (const [name] of FLIGHT_HELMET_FILES) {
            expect(fetchMock).toHaveBeenCalledWith(`https://raw.githubusercontent.com/BabylonJS/Assets/183f26290601abe1d5282eed00c306f4c8228307/meshes/FlightHelmetKTX/${name}`, {
                signal: expect.any(AbortSignal),
            });
        }
        expect(mocks.write).toHaveBeenCalledTimes(17);
        expect(mocks.rename).toHaveBeenCalledTimes(17);
        expect(mocks.remove).toHaveBeenCalledTimes(17);
        const [temp] = mocks.write.mock.calls[0]!;
        expect(mocks.rename.mock.calls[0]).toEqual([temp, expect.stringContaining("FlightHelmet.gltf")]);
    });

    it("fails setup with the asset URL and HTTP status instead of publishing an error body", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() => Promise.resolve(new Response("Unavailable", { status: 503 })))
        );

        await expect(fetchFlightHelmet()).rejects.toThrow(/FlightHelmet.gltf: HTTP 503/);

        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it("rejects corrupt downloads and checks stale cache entries before redownloading", async () => {
        mocks.exists.mockReturnValue(true);
        mocks.read.mockReturnValue(new Uint8Array([0]));
        mocks.digest.mockReturnValue("incorrect");
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("corrupt")));
        vi.stubGlobal("fetch", fetchMock);

        await expect(fetchFlightHelmet()).rejects.toThrow(/integrity check failed: .*FlightHelmet.gltf/);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("includes the URL when a request times out", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("request timed out")));

        await expect(fetchFlightHelmet()).rejects.toThrow(/FlightHelmet.gltf: request timed out/);
    });
});
