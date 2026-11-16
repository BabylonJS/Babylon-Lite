export type CompatColor4 = readonly [r: number, g: number, b: number, a: number];

function mapColor(color: CompatColor4, transform: (value: number, index: number) => number): CompatColor4 {
    return [transform(color[0], 0), transform(color[1], 1), transform(color[2], 2), transform(color[3], 3)];
}

export function divideTextureProcessConstants(a: CompatColor4, b: CompatColor4): CompatColor4 {
    return mapColor(a, (value, index) => value / Math.max(b[index] ?? 0, 0.00001));
}

export function transmissionFractionConstants(a: CompatColor4, b: CompatColor4): CompatColor4 {
    return mapColor(a, (value, index) => value / Math.max(value + (b[index] ?? 0) * (1 - value), 0.00001));
}

export function transmissionScatterToSingleScatterAlbedoConstants(transmissionColor: CompatColor4, transmissionScatter: CompatColor4): CompatColor4 {
    const extinction = transmissionColor.slice(0, 3).map((value) => -Math.log(Math.max(value, 0.0000001)));
    const shift = Math.min(0, ...extinction.map((value, index) => value - (transmissionScatter[index] ?? 0)));
    return [
        transmissionScatter[0] / Math.max(extinction[0]! - shift, 0.00001),
        transmissionScatter[1] / Math.max(extinction[1]! - shift, 0.00001),
        transmissionScatter[2] / Math.max(extinction[2]! - shift, 0.00001),
        transmissionScatter[3],
    ];
}

export function multiScatterToSingleScatterAlbedoConstants(multiScatter: CompatColor4, anisotropy = 0): CompatColor4 {
    const aniso = Math.min(Math.max(anisotropy, -0.9999), 0.9999);
    return mapColor(multiScatter, (value, index) => {
        if (index === 3) {
            return value;
        }
        const rho = Math.min(Math.max(value, 0), 1);
        const s = rho === 0 ? 1 : 4.09712 + 4.20863 * rho - Math.sqrt(9.59217 + 41.6808 * rho + 17.7126 * rho * rho);
        return (1 - s * s) / Math.max(1 - aniso * s * s, 0.0000001);
    });
}

export function singleScatterToMultiScatterAlbedoConstants(singleScatter: CompatColor4, anisotropy = 0): CompatColor4 {
    const aniso = Math.min(Math.max(anisotropy, -0.9999), 0.9999);
    return mapColor(singleScatter, (value, index) => {
        if (index === 3) {
            return value;
        }
        const albedo = Math.min(Math.max(value, 0), 1);
        const s = Math.sqrt(Math.max((1 - albedo) / Math.max(1 - aniso * albedo, 0.0000001), 0));
        return ((1 - s) * (1 - 0.139 * s)) / (1 + 1.17 * s);
    });
}

export function thinWalledScatterWeightConstants(transmission: number, scatter: number): { transmission: number; subsurface: number } {
    const transmittedScatter = transmission * scatter;
    const denominator = 1 - transmission + transmittedScatter;
    return {
        transmission: transmission * (1 - scatter),
        subsurface: denominator > 0.00001 ? transmittedScatter / denominator : 0,
    };
}
