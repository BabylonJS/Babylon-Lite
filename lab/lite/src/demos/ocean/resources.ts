import { createComputeStorageTexture, disposeComputeStorageTexture, type ComputeStorageTexture, type EngineContext } from "babylon-lite";
import { createOceanResourceScope, disposeOceanScope, ownOceanResource, rollbackOceanScope, type OceanResourceScope } from "./ownership.js";

export interface OceanFieldPair {
    readonly spectrum: ComputeStorageTexture;
    readonly spatial: ComputeStorageTexture;
}

export interface OceanCascadeResources {
    readonly h0k: ComputeStorageTexture;
    readonly h0: ComputeStorageTexture;
    readonly wavesData: ComputeStorageTexture;
    readonly dxDz: OceanFieldPair;
    readonly dyDxz: OceanFieldPair;
    readonly dyxDyz: OceanFieldPair;
    readonly dxxDzz: OceanFieldPair;
    readonly displacement: ComputeStorageTexture;
    readonly derivatives: ComputeStorageTexture;
    readonly turbulenceA: ComputeStorageTexture;
    readonly turbulenceB: ComputeStorageTexture;
}

export interface OceanComputeResources {
    readonly twiddle: ComputeStorageTexture;
    readonly cascades: readonly [OceanCascadeResources, OceanCascadeResources, OceanCascadeResources];
    readonly _scope: OceanResourceScope;
}

type TextureFactory = (options: Parameters<typeof createComputeStorageTexture>[1]) => Promise<ComputeStorageTexture>;

async function createField(create: TextureFactory, size: number, label: string): Promise<ComputeStorageTexture> {
    return create({
        width: size,
        height: size,
        viewDimension: "2d",
        format: "rg32float",
        access: "write-only",
        sampled: true,
        invertY: false,
        label,
    });
}

async function createRgba32(create: TextureFactory, width: number, height: number, label: string): Promise<ComputeStorageTexture> {
    return create({
        width,
        height,
        viewDimension: "2d",
        format: "rgba32float",
        access: "write-only",
        sampled: true,
        invertY: false,
        label,
    });
}

async function createOutput(create: TextureFactory, size: number, label: string, mipMaps = false): Promise<ComputeStorageTexture> {
    return create({
        width: size,
        height: size,
        viewDimension: "2d",
        format: "rgba16float",
        access: "write-only",
        sampled: true,
        mipMaps,
        sampler: {
            addressModeU: "repeat",
            addressModeV: "repeat",
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
            maxAnisotropy: 4,
        },
        invertY: false,
        label,
    });
}

async function createFieldPair(create: TextureFactory, size: number, label: string): Promise<OceanFieldPair> {
    return {
        spectrum: await createField(create, size, `${label}-spectrum`),
        spatial: await createField(create, size, `${label}-spatial`),
    };
}

async function createCascade(create: TextureFactory, size: number, index: number): Promise<OceanCascadeResources> {
    const prefix = `ocean-c${index}`;
    return {
        h0k: await createField(create, size, `${prefix}-h0k`),
        h0: await createRgba32(create, size, size, `${prefix}-h0`),
        wavesData: await createRgba32(create, size, size, `${prefix}-waves-data`),
        dxDz: await createFieldPair(create, size, `${prefix}-dx-dz`),
        dyDxz: await createFieldPair(create, size, `${prefix}-dy-dxz`),
        dyxDyz: await createFieldPair(create, size, `${prefix}-dyx-dyz`),
        dxxDzz: await createFieldPair(create, size, `${prefix}-dxx-dzz`),
        displacement: await createOutput(create, size, `${prefix}-displacement`),
        derivatives: await createOutput(create, size, `${prefix}-derivatives`, true),
        turbulenceA: await createOutput(create, size, `${prefix}-turbulence-a`, true),
        turbulenceB: await createOutput(create, size, `${prefix}-turbulence-b`, true),
    };
}

export async function createOceanComputeResources(engine: EngineContext, size: number, fftStages: number): Promise<OceanComputeResources> {
    const scope = createOceanResourceScope();
    const create: TextureFactory = async (options) => ownOceanResource(scope, await createComputeStorageTexture(engine, options), disposeComputeStorageTexture);
    try {
        return {
            twiddle: await createRgba32(create, fftStages, size, "ocean-fft-twiddle"),
            cascades: [await createCascade(create, size, 0), await createCascade(create, size, 1), await createCascade(create, size, 2)],
            _scope: scope,
        };
    } catch (error) {
        rollbackOceanScope(scope, error);
    }
}

export function disposeOceanComputeResources(resources: OceanComputeResources): void {
    disposeOceanScope(resources._scope);
}
