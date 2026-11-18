import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFreeciv } from "../../../scripts/fetch-freeciv";

const MERCATOR_URL = "https://raw.githubusercontent.com/BabylonJS/Assets/5e80e4a45dbfa30cae8f37c732ad10671b29b5f3/textures/lite/mercator-1569.png";
const MERCATOR_SHA256 = "5c1b84a3cf38b86d823edfc3144d0a6a158fc72fe60c167ce1afb7c126350291";

const mocks = vi.hoisted(() => ({
    exists: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    digest: vi.fn(),
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
        expect(algorithm).toBe("sha256");
        return {
            update: mocks.update,
            digest: mocks.digest,
        };
    },
}));

beforeEach(() => {
    vi.resetAllMocks();
    mocks.update.mockReturnValue({ update: mocks.update, digest: mocks.digest });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Freeciv Mercator backdrop setup", () => {
    it("reuses a verified cached mirror without downloading", async () => {
        mocks.exists.mockReturnValue(true);
        mocks.read.mockReturnValue(new Uint8Array([1, 2, 3]));
        mocks.digest.mockReturnValue(MERCATOR_SHA256);
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await fetchFreeciv();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.read).toHaveBeenCalledOnce();
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("downloads the immutable mirror, verifies it, and publishes it atomically", async () => {
        mocks.exists.mockImplementation((path: string) => !path.endsWith("mercator-1569.png") && !path.endsWith("mercator-1569.LICENSE.txt"));
        mocks.digest.mockReturnValue(MERCATOR_SHA256);
        const bytes = new Uint8Array([1, 2, 3]);
        const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
        vi.stubGlobal("fetch", fetchMock);

        await fetchFreeciv();

        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(MERCATOR_URL, { signal: expect.any(AbortSignal) });
        expect(mocks.update).toHaveBeenCalledWith(Buffer.from(bytes));
        expect(mocks.write).toHaveBeenCalledTimes(2);
        expect(mocks.rename).toHaveBeenCalledOnce();
        expect(mocks.remove).toHaveBeenCalledOnce();
    });

    it("rejects a corrupt mirror response before publishing it", async () => {
        mocks.exists.mockImplementation((path: string) => !path.endsWith("mercator-1569.png") && !path.endsWith("mercator-1569.LICENSE.txt"));
        mocks.digest.mockReturnValue("incorrect");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

        await expect(fetchFreeciv()).rejects.toThrow(`expected ${MERCATOR_SHA256}, received incorrect`);

        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
