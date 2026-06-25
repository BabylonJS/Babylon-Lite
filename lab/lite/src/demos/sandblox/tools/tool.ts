/**
 * Tool — the thin-controller contract. Faithful to the HopperBin
 * model: a tool is a small script that wires the shared services (Mouse,
 * Dragger, SelectionBox) to Part mutations while selected, and cleans up
 * completely when deselected.
 */

import type { SelectionBox } from "../adornments/selection-box.js";
import type { Dragger } from "../dragger.js";
import type { Mouse } from "../mouse.js";
import type { Part } from "../part.js";
import type { Sounds } from "../sounds.js";
import type { Workspace } from "../workspace.js";

export interface ToolContext {
    readonly workspace: Workspace<Part>;
    readonly mouse: Mouse;
    readonly dragger: Dragger;
    readonly selectionBox: SelectionBox;
    readonly sounds: Sounds;
}

export interface Tool {
    activate(): void;
    deactivate(): void;
}
