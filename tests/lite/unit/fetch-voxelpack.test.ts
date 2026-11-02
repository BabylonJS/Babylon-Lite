import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchVoxelpack, VOXELPACK_FILES } from "../../../scripts/fetch-voxelpack";

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

describe("Kenney Voxel Pack fixture setup", () => {
    it("reuses every verified file without downloading or rewriting", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        mocks.exists.mockReturnValue(true);
        mocks.read.mockReturnValue(bytes);
        for (const [, digest] of VOXELPACK_FILES) {
            mocks.digest.mockReturnValueOnce(digest);
        }
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await fetchVoxelpack();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.read).toHaveBeenCalledTimes(VOXELPACK_FILES.length);
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("downloads immutable URLs, verifies bytes, then atomically publishes files", async () => {
        for (const [, digest] of VOXELPACK_FILES) {
            mocks.digest.mockReturnValueOnce(digest);
        }
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
        vi.stubGlobal("fetch", fetchMock);

        await fetchVoxelpack();

        expect(fetchMock).toHaveBeenCalledTimes(VOXELPACK_FILES.length);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://raw.githubusercontent.com/series-ai/jam-ready-assets/ab1b21fe61bc3adeb759c286e770033563f18a97/kenney-voxel-pack/2D/prototype-blocks/PNG/Tiles/dirt.png",
            { signal: expect.any(AbortSignal) }
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "https://raw.githubusercontent.com/series-ai/jam-ready-assets/ab1b21fe61bc3adeb759c286e770033563f18a97/kenney-voxel-pack/2D/prototype-blocks/License.txt",
            { signal: expect.any(AbortSignal) }
        );
        expect(mocks.write).toHaveBeenCalledTimes(VOXELPACK_FILES.length);
        expect(mocks.rename).toHaveBeenCalledTimes(VOXELPACK_FILES.length);
        expect(mocks.remove).toHaveBeenCalledTimes(VOXELPACK_FILES.length);
    });

    it("rejects an HTTP error body instead of publishing it as an asset", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() => Promise.resolve(new Response("Forbidden", { status: 403 })))
        );

        await expect(fetchVoxelpack()).rejects.toThrow(/dirt\.png: HTTP 403/);

        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it("rejects a download that does not match the pinned asset", async () => {
        mocks.digest.mockReturnValue("incorrect");
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() => Promise.resolve(new Response("<!doctype html>")))
        );

        await expect(fetchVoxelpack()).rejects.toThrow(/integrity check failed: .*dirt\.png/);

        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
