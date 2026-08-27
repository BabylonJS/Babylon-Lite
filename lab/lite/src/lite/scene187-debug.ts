import type { SmaaPostProcessTask } from "babylon-lite";

type NumericSetting = "threshold" | "maxSearchSteps" | "minDiagonalRun";
type BooleanSetting = "diagonalDetection" | "cornerDetection" | "dominantAxisBlend" | "sourceIsSrgb";

const DEFAULTS = {
    threshold: 0.03,
    maxSearchSteps: 64,
    diagonalDetection: false,
    minDiagonalRun: 4,
    cornerDetection: false,
    dominantAxisBlend: true,
    sourceIsSrgb: false,
} as const;

function setStyles(element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
    Object.assign(element.style, styles);
}

function updateMetadata(smaa: SmaaPostProcessTask, canvas: HTMLCanvasElement): void {
    canvas.dataset.smaaThreshold = String(smaa.threshold);
    canvas.dataset.smaaMaxSearchSteps = String(smaa.maxSearchSteps);
    canvas.dataset.smaaDiagonalDetection = String(smaa.diagonalDetection);
    canvas.dataset.smaaMinDiagonalRun = String(smaa.minDiagonalRun);
    canvas.dataset.smaaCornerDetection = String(smaa.cornerDetection);
    canvas.dataset.smaaDominantAxisBlend = String(smaa.dominantAxisBlend);
    canvas.dataset.smaaSourceIsSrgb = String(smaa.sourceIsSrgb);
}

export function attachSmaaDebugControls(smaa: SmaaPostProcessTask, canvas: HTMLCanvasElement): void {
    const panel = document.createElement("aside");
    panel.dataset.smaaControls = "true";
    setStyles(panel, {
        position: "absolute",
        top: "54px",
        left: "20px",
        width: "290px",
        padding: "14px",
        boxSizing: "border-box",
        border: "1px solid #66758f",
        borderRadius: "8px",
        background: "rgba(5, 10, 20, 0.92)",
        color: "#eef4ff",
        font: "13px/1.3 system-ui, sans-serif",
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.45)",
        zIndex: "10",
    });

    const title = document.createElement("div");
    title.textContent = "SMAA parameters";
    setStyles(title, { marginBottom: "10px", fontWeight: "700", fontSize: "15px" });
    panel.appendChild(title);

    const controls = new Map<string, HTMLInputElement>();
    const outputs = new Map<string, HTMLOutputElement>();

    const apply = (): void => {
        smaa.updateUniforms();
        updateMetadata(smaa, canvas);
    };

    const addRange = (key: NumericSetting, labelText: string, min: number, max: number, step: number): void => {
        const label = document.createElement("label");
        setStyles(label, { display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px", marginBottom: "10px" });

        const caption = document.createElement("span");
        caption.textContent = labelText;
        const output = document.createElement("output");
        output.value = String(smaa[key]);

        const input = document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(smaa[key]);
        input.dataset.smaaControl = key;
        setStyles(input, { gridColumn: "1 / 3", width: "100%" });
        input.addEventListener("input", () => {
            smaa[key] = Number(input.value);
            output.value = String(smaa[key]);
            apply();
        });

        controls.set(key, input);
        outputs.set(key, output);
        label.append(caption, output, input);
        panel.appendChild(label);
    };

    const addCheckbox = (key: BooleanSetting, labelText: string): void => {
        const label = document.createElement("label");
        setStyles(label, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "9px" });
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = smaa[key];
        input.dataset.smaaControl = key;
        input.addEventListener("change", () => {
            smaa[key] = input.checked;
            apply();
        });
        controls.set(key, input);
        label.append(input, document.createTextNode(labelText));
        panel.appendChild(label);
    };

    addRange("threshold", "Edge threshold", 0.005, 0.5, 0.005);
    addRange("maxSearchSteps", "Max search steps", 1, 112, 1);
    addCheckbox("diagonalDetection", "Diagonal detection");
    addRange("minDiagonalRun", "Minimum diagonal run", 2, 32, 1);
    addCheckbox("cornerDetection", "Corner-pattern attenuation");
    addCheckbox("dominantAxisBlend", "Dominant-axis blend");
    addCheckbox("sourceIsSrgb", "Source texture is sRGB");

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.dataset.smaaReset = "true";
    setStyles(reset, {
        width: "100%",
        marginTop: "3px",
        padding: "7px",
        border: "1px solid #6d7f9d",
        borderRadius: "5px",
        background: "#18243a",
        color: "#fff",
        cursor: "pointer",
    });
    reset.addEventListener("click", () => {
        for (const key of ["threshold", "maxSearchSteps", "minDiagonalRun"] as const) {
            smaa[key] = DEFAULTS[key];
            controls.get(key)!.value = String(smaa[key]);
            outputs.get(key)!.value = String(smaa[key]);
        }
        for (const key of ["diagonalDetection", "cornerDetection", "dominantAxisBlend", "sourceIsSrgb"] as const) {
            smaa[key] = DEFAULTS[key];
            controls.get(key)!.checked = smaa[key];
        }
        apply();
    });
    panel.appendChild(reset);
    document.body.appendChild(panel);
    updateMetadata(smaa, canvas);
}
