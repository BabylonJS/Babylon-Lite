export type OceanSkyParameter = "inclination" | "azimuth" | "luminance" | "turbidity" | "rayleigh" | "mieCoefficient" | "mieDirectionalG";
export type OceanWaveParameter =
    | "gravity"
    | "depth"
    | "lambda"
    | "local.scale"
    | "local.windSpeed"
    | "local.windDirection"
    | "local.fetch"
    | "local.spreadBlend"
    | "local.swell"
    | "local.peakEnhancement"
    | "local.shortWavesFade"
    | "swell.scale"
    | "swell.windSpeed"
    | "swell.windDirection"
    | "swell.fetch"
    | "swell.spreadBlend"
    | "swell.swell"
    | "swell.peakEnhancement"
    | "swell.shortWavesFade";
export type OceanGeometryParameter = "lengthScale" | "vertexDensity" | "clipLevels" | "skirtSize";
export type OceanShaderNumberParameter = "maxGloss" | "roughnessScale" | "lodScale" | "foamScale" | "contactFoam" | "foamBias" | "sssStrength" | "sssBase" | "sssScale";
export type OceanShaderColorParameter = "waterColor" | "foamColor" | "sssColor";

export interface OceanControlTargets {
    setPaused(paused: boolean): void;
    setBloomEnabled(enabled: boolean): void;
    setResolution(size: number): void;
    setEnvironmentIntensity(value: number): void;
    setLightIntensity(value: number): void;
    setShadowsEnabled(enabled: boolean): void;
    setDebugEnabled(enabled: boolean): void;
    setSkyParameter(name: OceanSkyParameter, value: number): void;
    setWaveParameter(name: OceanWaveParameter, value: number): void;
    setGeometryParameter(name: OceanGeometryParameter, value: number): void;
    setWireframe(enabled: boolean): void;
    setNoMaterialLod(enabled: boolean): void;
    setShaderNumber(name: OceanShaderNumberParameter, value: number): void;
    setShaderColor(name: OceanShaderColorParameter, value: string): void;
    setBuoyancyEnabled(enabled: boolean): void;
    setBuoyancyAttenuation(value: number): void;
    setBuoyancySteps(value: number): void;
}

export interface OceanControlInitial {
    readonly paused?: boolean;
    readonly resolution?: number;
    readonly lengthScale?: number;
    readonly vertexDensity?: number;
    readonly clipLevels?: number;
    readonly skirtSize?: number;
    readonly wireframe?: boolean;
    readonly noMaterialLod?: boolean;
}

interface RangeSpec {
    readonly label: string;
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly apply: (value: number) => void;
}

function section(root: HTMLElement, title: string, open = false): HTMLElement {
    const details = document.createElement("details");
    details.open = open;
    const summary = document.createElement("summary");
    summary.textContent = title;
    details.appendChild(summary);
    root.appendChild(details);
    return details;
}

function range(root: HTMLElement, spec: RangeSpec): void {
    const label = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = spec.label;
    const output = document.createElement("output");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.value);
    const update = (): void => {
        const value = Number(input.value);
        output.value = spec.step < 0.01 ? value.toFixed(3) : value.toFixed(2);
        spec.apply(value);
    };
    input.addEventListener("input", update);
    label.append(title, output, input);
    root.appendChild(label);
    update();
}

function checkbox(root: HTMLElement, label: string, value: boolean, apply: (value: boolean) => void): HTMLInputElement {
    const row = document.createElement("label");
    row.className = "check-row";
    const title = document.createElement("span");
    title.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => apply(input.checked));
    row.append(title, input);
    root.appendChild(row);
    apply(value);
    return input;
}

function select(root: HTMLElement, label: string, value: number, values: readonly number[], apply: (value: number) => void): void {
    const row = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = label;
    const input = document.createElement("select");
    for (const optionValue of values) {
        const option = document.createElement("option");
        option.value = String(optionValue);
        option.textContent = String(optionValue);
        option.selected = optionValue === value;
        input.appendChild(option);
    }
    input.addEventListener("change", () => apply(Number(input.value)));
    row.append(title, input);
    root.appendChild(row);
}

function color(root: HTMLElement, label: string, value: string, apply: (value: string) => void): void {
    const row = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = label;
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.addEventListener("input", () => apply(input.value));
    row.append(title, input);
    root.appendChild(row);
    apply(value);
}

export function bindOceanControls(targets: OceanControlTargets, initial: OceanControlInitial = {}): void {
    const root = document.getElementById("ocean-controls");
    if (!root) {
        throw new Error("Ocean controls root is missing.");
    }
    root.replaceChildren();

    const actions = document.createElement("div");
    actions.className = "row";
    const pause = document.createElement("button");
    pause.type = "button";
    let paused = initial.paused ?? false;
    const refreshPause = (): void => {
        pause.textContent = paused ? "Resume" : "Pause";
        targets.setPaused(paused);
    };
    pause.addEventListener("click", () => {
        paused = !paused;
        refreshPause();
    });
    actions.appendChild(pause);
    root.appendChild(actions);
    checkbox(actions, "Bloom", false, targets.setBloomEnabled);
    refreshPause();

    const general = section(root, "General", true);
    select(general, "Resolution", initial.resolution ?? 256, [256, 128, 64, 32], targets.setResolution);
    range(general, { label: "Env intensity", value: 1, min: 0, max: 4, step: 0.05, apply: targets.setEnvironmentIntensity });
    range(general, { label: "Light intensity", value: 1, min: 0, max: 5, step: 0.05, apply: targets.setLightIntensity });
    checkbox(general, "Enable shadows", true, targets.setShadowsEnabled);
    checkbox(general, "Show debug RTT", false, targets.setDebugEnabled);

    const sky = section(root, "Sky", true);
    const skyRanges: readonly [OceanSkyParameter, string, number, number, number, number][] = [
        ["inclination", "Inclination", 0, -0.5, 0.5, 0.001],
        ["azimuth", "Azimuth", 0.307, 0, 1, 0.001],
        ["luminance", "Luminance", 1, 0.001, 1, 0.001],
        ["turbidity", "Turbidity", 10, 0.1, 100, 0.1],
        ["rayleigh", "Rayleigh", 2, 0.1, 10, 0.1],
        ["mieCoefficient", "Mie coefficient", 0.005, 0, 0.1, 0.0001],
        ["mieDirectionalG", "Mie directional G", 0.8, 0, 1, 0.01],
    ];
    for (const [name, label, value, min, max, step] of skyRanges) {
        range(sky, { label, value, min, max, step, apply: (next) => targets.setSkyParameter(name, next) });
    }

    const waves = section(root, "Waves Generator", true);
    const waveRanges: readonly [OceanWaveParameter, string, number, number, number, number][] = [
        ["gravity", "Gravity", 9.81, 0.01, 30, 0.01],
        ["depth", "Ocean depth", 3, 0.001, 3, 0.001],
        ["lambda", "Lambda", 1, 0, 1, 0.001],
        ["local.scale", "Local · Scale", 0.5, 0, 1, 0.001],
        ["local.windSpeed", "Local · Wind speed", 1.5, 0.001, 100, 0.001],
        ["local.windDirection", "Local · Wind direction", -29.81, -100, 100, 0.1],
        ["local.fetch", "Local · Fetch", 100000, 100, 1000000, 100],
        ["local.spreadBlend", "Local · Spread blend", 1, 0, 1, 0.01],
        ["local.swell", "Local · Swell", 0.198, 0, 1, 0.01],
        ["local.peakEnhancement", "Local · Peak enhancement", 3.3, 0.01, 100, 0.01],
        ["local.shortWavesFade", "Local · Short waves fade", 0.01, 0.001, 1, 0.001],
        ["swell.scale", "Swell · Scale", 0.5, 0, 1, 0.001],
        ["swell.windSpeed", "Swell · Wind speed", 1.5, 0.001, 100, 0.001],
        ["swell.windDirection", "Swell · Wind direction", 90, -100, 100, 0.1],
        ["swell.fetch", "Swell · Fetch", 300000, 100, 1000000, 100],
        ["swell.spreadBlend", "Swell · Spread blend", 1, 0, 1, 0.01],
        ["swell.swell", "Swell · Swell", 1, 0, 1, 0.01],
        ["swell.peakEnhancement", "Swell · Peak enhancement", 3.3, 0.01, 100, 0.01],
        ["swell.shortWavesFade", "Swell · Short waves fade", 0.01, 0.001, 1, 0.001],
    ];
    for (const [name, label, value, min, max, step] of waveRanges) {
        range(waves, { label, value, min, max, step, apply: (next) => targets.setWaveParameter(name, next) });
    }

    const geometry = section(root, "Ocean Geometry");
    const geometryRanges: readonly [OceanGeometryParameter, string, number, number, number, number][] = [
        ["lengthScale", "Length scale", initial.lengthScale ?? 15, 1, 100, 0.1],
        ["vertexDensity", "Vertex density", initial.vertexDensity ?? 30, 1, 40, 1],
        ["clipLevels", "Clip levels", initial.clipLevels ?? 8, 1, 8, 1],
        ["skirtSize", "Skirt size", initial.skirtSize ?? 10, 0, 100, 0.1],
    ];
    for (const [name, label, value, min, max, step] of geometryRanges) {
        range(geometry, { label, value, min, max, step, apply: (next) => targets.setGeometryParameter(name, next) });
    }
    checkbox(geometry, "Wireframe", initial.wireframe ?? false, targets.setWireframe);
    checkbox(geometry, "No material LOD", initial.noMaterialLod ?? true, targets.setNoMaterialLod);

    const shader = section(root, "Ocean Shader");
    color(shader, "Color", "#214559", (value) => targets.setShaderColor("waterColor", value));
    range(shader, { label: "Max gloss", value: 0.91, min: 0, max: 1, step: 0.01, apply: (value) => targets.setShaderNumber("maxGloss", value) });
    range(shader, { label: "Roughness scale", value: 0.0044, min: 0, max: 1, step: 0.0001, apply: (value) => targets.setShaderNumber("roughnessScale", value) });
    range(shader, { label: "LOD scale", value: 7.13, min: 0.01, max: 20, step: 0.01, apply: (value) => targets.setShaderNumber("lodScale", value) });
    color(shader, "Foam color", "#ffffff", (value) => targets.setShaderColor("foamColor", value));
    range(shader, { label: "Foam scale", value: 2.4, min: 0.001, max: 8, step: 0.001, apply: (value) => targets.setShaderNumber("foamScale", value) });
    range(shader, { label: "Foam contact", value: 1, min: 0.001, max: 3, step: 0.001, apply: (value) => targets.setShaderNumber("contactFoam", value) });
    range(shader, { label: "Foam bias", value: 2.72, min: 0.001, max: 4, step: 0.001, apply: (value) => targets.setShaderNumber("foamBias", value) });
    color(shader, "SSS color", "#6df1fe", (value) => targets.setShaderColor("sssColor", value));
    range(shader, { label: "SSS strength", value: 0.15, min: 0.001, max: 2, step: 0.001, apply: (value) => targets.setShaderNumber("sssStrength", value) });
    range(shader, { label: "SSS base", value: -0.261, min: -2, max: 1, step: 0.001, apply: (value) => targets.setShaderNumber("sssBase", value) });
    range(shader, { label: "SSS scale", value: 4.7, min: 0.001, max: 10, step: 0.001, apply: (value) => targets.setShaderNumber("sssScale", value) });

    const buoyancy = section(root, "Buoyancy");
    checkbox(buoyancy, "Enabled", true, targets.setBuoyancyEnabled);
    range(buoyancy, { label: "Damping factor", value: 0.2, min: 0, max: 1, step: 0.001, apply: targets.setBuoyancyAttenuation });
    range(buoyancy, { label: "Num steps", value: 3, min: 1, max: 20, step: 1, apply: targets.setBuoyancySteps });
}
