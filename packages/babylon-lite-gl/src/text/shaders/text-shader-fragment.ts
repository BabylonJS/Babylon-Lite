/** @internal Typed composition slots; feature modules own all optional shader logic. */
export interface TextShaderFragment {
    /** @internal */
    readonly _id: string;
    /** @internal */
    readonly _vertexSlots?: Partial<Record<"VO" | "VD" | "VB" | "VA", string>>;
    /** @internal */
    readonly _fragmentSlots?: Partial<Record<"FI" | "FH" | "CO", string>>;
}
