/**
 * Map IO UI — two small corner buttons: Export downloads the current
 * world as `map.json`; Import replaces the unlocked world from a chosen file.
 * This supports quick local iteration: build, export, load, tweak, re-export.
 */

import type { Part, PartOptions } from "./part.js";
import { loadWorld, serializeWorld } from "./world-io.js";
import type { Workspace } from "./workspace.js";

const CSS = `
.sandblox-mapio {
    position: fixed;
    right: 8px;
    bottom: 8px;
    display: flex;
    gap: 5px;
    z-index: 1000;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    user-select: none;
}
.sandblox-mapio button {
    border: none;
    background: rgba(60, 60, 60, 0.6);
    color: rgba(220, 220, 220, 1);
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
}
.sandblox-mapio button:hover {
    background: rgba(80, 80, 80, 0.75);
}

/* On narrow viewports the bottom-center toolbar would overlap these
   bottom-right buttons — move them to the free top-left corner. */
@media (max-width: 768px) {
    .sandblox-mapio {
        top: 5px;
        left: 5px;
        right: auto;
        bottom: auto;
    }
}
`;

export function createMapIoUi(workspace: Workspace<Part>, createPart: (options: PartOptions) => Part): void {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.className = "sandblox-mapio";

    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export map";
    exportBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep canvas focus
    exportBtn.addEventListener("click", () => {
        const json = JSON.stringify(serializeWorld(workspace), null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "map.json";
        a.click();
        URL.revokeObjectURL(url);
    });

    const importBtn = document.createElement("button");
    importBtn.textContent = "Import map";
    importBtn.addEventListener("mousedown", (e) => e.preventDefault());
    importBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) {
                return;
            }
            void file.text().then((text) => {
                let json: unknown;
                try {
                    json = JSON.parse(text);
                } catch {
                    console.warn("map import: not valid JSON");
                    return;
                }
                // Replace the unlocked world.
                for (const part of [...workspace.parts]) {
                    if (!part.locked) {
                        part.destroy();
                    }
                }
                loadWorld(json, createPart);
            });
        });
        input.click();
    });

    root.appendChild(exportBtn);
    root.appendChild(importBtn);
    document.body.appendChild(root);
}
