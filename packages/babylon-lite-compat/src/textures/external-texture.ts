import { createExternalTexture, isExternalTextureReady } from "babylon-lite";
import type { ExternalTexture as LiteExternalTexture } from "babylon-lite";

let nextUniqueId = 0;

/** Babylon.js `ExternalTexture` over Lite's caller-owned video wrapper. */
export class ExternalTexture {
    /** @internal Underlying Lite external texture. */
    public readonly _lite: LiteExternalTexture;
    public useMipMaps = false;
    public readonly type = 16;
    public readonly format = 0xffffffff;
    public readonly uniqueId = nextUniqueId++;

    public static IsExternalTexture(texture: unknown): texture is ExternalTexture {
        return !!texture && typeof texture === "object" && (texture as { underlyingResource?: unknown }).underlyingResource !== undefined;
    }

    public constructor(private readonly _video: HTMLVideoElement) {
        this._lite = createExternalTexture(_video);
    }

    public getClassName(): string {
        return "ExternalTexture";
    }

    public get underlyingResource(): HTMLVideoElement {
        return this._video;
    }

    public isReady(): boolean {
        return isExternalTextureReady(this._lite);
    }

    public dispose(): void {}
}
