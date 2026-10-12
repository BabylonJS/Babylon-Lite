import type { RenderTargetSignature } from "./render-target.js";

/** Stringified signature used to key pipelines against a render target's attachment set. */
export function targetSignatureKey(desc: RenderTargetSignature): string {
    return `${desc._colorFormat ?? "-"}|${desc._depthStencilFormat ?? "-"}|${desc._depthCompare ?? ""}|${desc._sampleCount}`;
}
