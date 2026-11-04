import { OCEAN_DEPTH, OCEAN_GRAVITY, OCEAN_LAMBDA } from "./constants.js";

export interface OceanDisplaySpectrum {
    scale: number;
    windSpeed: number;
    windDirection: number;
    fetch: number;
    spreadBlend: number;
    swell: number;
    peakEnhancement: number;
    shortWavesFade: number;
}

export interface OceanSpectrumSettings {
    gravity: number;
    depth: number;
    lambda: number;
    local: OceanDisplaySpectrum;
    swell: OceanDisplaySpectrum;
}

export const DEFAULT_OCEAN_SPECTRUM: OceanSpectrumSettings = {
    gravity: OCEAN_GRAVITY,
    depth: OCEAN_DEPTH,
    lambda: OCEAN_LAMBDA,
    local: {
        scale: 0.5,
        windSpeed: 1.5,
        windDirection: -29.81,
        fetch: 100_000,
        spreadBlend: 1,
        swell: 0.198,
        peakEnhancement: 3.3,
        shortWavesFade: 0.01,
    },
    swell: {
        scale: 0.5,
        windSpeed: 1.5,
        windDirection: 90,
        fetch: 300_000,
        spreadBlend: 1,
        swell: 1,
        peakEnhancement: 3.3,
        shortWavesFade: 0.01,
    },
};

function jonswapAlpha(gravity: number, fetch: number, windSpeed: number): number {
    return 0.076 * Math.pow((gravity * fetch) / (windSpeed * windSpeed), -0.22);
}

function jonswapPeakFrequency(gravity: number, fetch: number, windSpeed: number): number {
    return 22 * Math.pow((windSpeed * fetch) / (gravity * gravity), -0.33);
}

function writeSpectrum(target: Float32Array, offset: number, gravity: number, source: OceanDisplaySpectrum): void {
    target[offset] = source.scale;
    target[offset + 1] = (source.windDirection * Math.PI) / 180;
    target[offset + 2] = source.spreadBlend;
    target[offset + 3] = Math.min(1, Math.max(0.01, source.swell));
    target[offset + 4] = jonswapAlpha(gravity, source.fetch, source.windSpeed);
    target[offset + 5] = jonswapPeakFrequency(gravity, source.fetch, source.windSpeed);
    target[offset + 6] = source.peakEnhancement;
    target[offset + 7] = source.shortWavesFade;
}

export function createOceanSpectrumBuffer(settings: OceanSpectrumSettings = DEFAULT_OCEAN_SPECTRUM): Float32Array {
    const data = new Float32Array(16);
    writeSpectrum(data, 0, settings.gravity, settings.local);
    writeSpectrum(data, 8, settings.gravity, settings.swell);
    return data;
}
