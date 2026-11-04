import { getWhiteBalanceMatrix, MaxTintMagnitude, MinTemperatureKelvin, temperatureTintToXyz } from "babylon-lite";

import { Vector3 } from "./vector.js";

export { MinTemperatureKelvin, MaxTintMagnitude };

export function TemperatureTintToXyz(temperatureKelvin: number, tint: number): Vector3 {
    const [x, y, z] = temperatureTintToXyz(temperatureKelvin, tint);
    return new Vector3(x, y, z);
}

export function GetWhiteBalanceMatrix(temperatureKelvin: number, tint: number): Float32Array {
    return getWhiteBalanceMatrix(temperatureKelvin, tint);
}
