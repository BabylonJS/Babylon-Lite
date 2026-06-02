/** DOM control panel for the dress-room demo.
 *
 *  Pure DOM — no framework. The panel is a fixed overlay on the left edge of
 *  the canvas. It talks to the demo exclusively through the {@link DressRoomApi}
 *  the caller supplies, so this module knows nothing about Babylon Lite. */

/** A slot exposed to the UI. */
export interface UiSlot {
    id: string;
    label: string;
    options: { id: string; label: string }[];
}

/** The contract the demo provides to drive the panel. */
export interface DressRoomApi {
    slots: UiSlot[];
    animations: string[];
    presets: string[];
    /** When false, the Armour Tint section is omitted (e.g. image-textured assets). */
    tintable?: boolean;
    getOption(slot: string): string;
    setOption(slot: string, optionId: string): void;
    cycleOption(slot: string, dir: 1 | -1): void;
    getAnimation(): string;
    setAnimation(name: string): void;
    /** Current tint for a slot's equipped piece, or null when nothing is equipped. */
    getTint(slot: string): [number, number, number] | null;
    setTint(slot: string, rgb: [number, number, number]): void;
    resetTint(slot: string): void;
    randomize(): void;
    applyPreset(name: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function toHex(rgb: [number, number, number]): string {
    const h = (v: number) =>
        Math.max(0, Math.min(255, Math.round(v * 255)))
            .toString(16)
            .padStart(2, "0");
    return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

function fromHex(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Build the panel, append it to the document, and wire it to `api`.
 *  Returns a `refresh()` that re-reads state into every control (call it after
 *  randomize / preset so the panel reflects the new loadout). */
export function buildPanel(api: DressRoomApi): { refresh: () => void } {
    injectStyles();
    const panel = el("div", "dr-panel");

    const title = el("div", "dr-title", "Dressing Room");
    panel.appendChild(title);

    const refreshers: (() => void)[] = []; // Reassigned by the tint section when present; a no-op otherwise so the
    // equipment arrows can always call it safely.
    let syncTint = (): void => {};
    // ── Equipment slots ──────────────────────────────────────────────
    const gearSection = el("div", "dr-section");
    gearSection.appendChild(el("div", "dr-heading", "Equipment"));
    let tintSlotSelect: HTMLSelectElement | null = null;
    for (const slot of api.slots) {
        const row = el("div", "dr-row");
        const prev = el("button", "dr-arrow", "‹");
        const name = el("div", "dr-slot-name");
        const next = el("button", "dr-arrow", "›");
        const label = el("div", "dr-slot-label", slot.label);

        const sync = () => {
            const current = api.getOption(slot.id);
            const opt = slot.options.find((o) => o.id === current);
            name.textContent = opt ? opt.label : current;
        };
        refreshers.push(sync);

        prev.addEventListener("click", () => {
            api.cycleOption(slot.id, -1);
            sync();
            syncTint();
        });
        next.addEventListener("click", () => {
            api.cycleOption(slot.id, 1);
            sync();
            syncTint();
        });

        const swatch = el("div", "dr-swatch-col");
        swatch.appendChild(label);
        const picker = el("div", "dr-picker");
        picker.append(prev, name, next);
        swatch.appendChild(picker);
        row.appendChild(swatch);
        gearSection.appendChild(row);
        sync();
    }
    panel.appendChild(gearSection);

    // ── Animation switcher (only when the demo exposes animations) ────
    if (api.animations.length > 0) {
        const animSection = el("div", "dr-section");
        animSection.appendChild(el("div", "dr-heading", "Animation"));
        const animRow = el("div", "dr-btn-grid");
        const animButtons = new Map<string, HTMLButtonElement>();
        const syncAnim = () => {
            const active = api.getAnimation();
            for (const [anim, btn] of animButtons) {
                btn.classList.toggle("is-active", anim === active);
            }
        };
        for (const anim of api.animations) {
            const btn = el("button", "dr-chip", anim);
            btn.addEventListener("click", () => {
                api.setAnimation(anim);
                syncAnim();
            });
            animButtons.set(anim, btn);
            animRow.appendChild(btn);
        }
        refreshers.push(syncAnim);
        animSection.appendChild(animRow);
        panel.appendChild(animSection);
    }

    // ── Armour tint (only when the demo's materials support tinting) ──
    if (api.tintable !== false) {
        const tintSection = el("div", "dr-section");
        tintSection.appendChild(el("div", "dr-heading", "Armour Tint"));
        const tintRow = el("div", "dr-row");
        tintSlotSelect = el("select", "dr-select");
        for (const slot of api.slots) {
            const opt = el("option");
            opt.value = slot.id;
            opt.textContent = slot.label;
            tintSlotSelect.appendChild(opt);
        }
        const color = el("input", "dr-color") as HTMLInputElement;
        color.type = "color";
        const resetTint = el("button", "dr-mini", "Reset");

        syncTint = () => {
            if (!tintSlotSelect) {
                return;
            }
            const slotId = tintSlotSelect.value;
            const tint = api.getTint(slotId);
            if (tint) {
                color.value = toHex(tint);
                color.disabled = false;
                resetTint.disabled = false;
            } else {
                color.disabled = true;
                resetTint.disabled = true;
            }
        };
        refreshers.push(syncTint);

        tintSlotSelect.addEventListener("change", syncTint);
        color.addEventListener("input", () => {
            if (tintSlotSelect) {
                api.setTint(tintSlotSelect.value, fromHex(color.value));
            }
        });
        resetTint.addEventListener("click", () => {
            if (tintSlotSelect) {
                api.resetTint(tintSlotSelect.value);
                syncTint();
            }
        });
        tintRow.append(tintSlotSelect, color, resetTint);
        tintSection.appendChild(tintRow);
        panel.appendChild(tintSection);
    }

    // ── Loadouts ─────────────────────────────────────────────────────
    const loadSection = el("div", "dr-section");
    loadSection.appendChild(el("div", "dr-heading", "Loadout"));
    const loadGrid = el("div", "dr-btn-grid");
    const refreshAll = () => {
        for (const fn of refreshers) {
            fn();
        }
    };
    const randomize = el("button", "dr-chip dr-accent", "Randomize");
    randomize.addEventListener("click", () => {
        api.randomize();
        refreshAll();
    });
    loadGrid.appendChild(randomize);
    for (const preset of api.presets) {
        const btn = el("button", "dr-chip", preset);
        btn.addEventListener("click", () => {
            api.applyPreset(preset);
            refreshAll();
        });
        loadGrid.appendChild(btn);
    }
    loadSection.appendChild(loadGrid);
    panel.appendChild(loadSection);

    const hint = el("div", "dr-hint", "Drag to orbit · scroll to zoom");
    panel.appendChild(hint);

    document.body.appendChild(panel);
    refreshAll();
    return { refresh: refreshAll };
}

function injectStyles(): void {
    if (document.getElementById("dr-style")) {
        return;
    }
    const style = el("style");
    style.id = "dr-style";
    style.textContent = `
.dr-panel {
  position: fixed; top: 16px; left: 16px; z-index: 50;
  width: 240px; max-height: calc(100vh - 32px); overflow-y: auto;
  padding: 14px; box-sizing: border-box;
  background: rgba(18, 16, 22, 0.82); color: #f1ece8;
  border: 1px solid rgba(224, 104, 75, 0.35); border-radius: 12px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  backdrop-filter: blur(8px); user-select: none;
}
.dr-title { font-size: 1.15rem; font-weight: 700; margin-bottom: 10px; letter-spacing: 0.3px; }
.dr-section { margin-bottom: 14px; }
.dr-heading { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: #e0684b; margin-bottom: 6px; }
.dr-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dr-slot-label { font-size: 0.72rem; color: #b8a9a4; margin-bottom: 2px; }
.dr-picker { display: flex; align-items: center; gap: 4px; }
.dr-swatch-col { flex: 1; }
.dr-slot-name { flex: 1; text-align: center; font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-arrow { width: 24px; height: 24px; border-radius: 6px; border: none; cursor: pointer;
  background: rgba(255,255,255,0.08); color: #f1ece8; font-size: 1rem; line-height: 1; }
.dr-arrow:hover { background: rgba(224,104,75,0.35); }
.dr-btn-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.dr-chip { padding: 6px 10px; border-radius: 8px; border: none; cursor: pointer;
  background: rgba(255,255,255,0.08); color: #f1ece8; font-size: 0.8rem; }
.dr-chip:hover { background: rgba(224,104,75,0.3); }
.dr-chip.is-active { background: #e0684b; color: #fff; font-weight: 600; }
.dr-accent { background: rgba(224,104,75,0.55); font-weight: 600; }
.dr-select { flex: 1; padding: 5px; border-radius: 6px; border: none;
  background: rgba(255,255,255,0.1); color: #f1ece8; font-size: 0.8rem; }
.dr-color { width: 36px; height: 28px; padding: 0; border: none; background: none; cursor: pointer; }
.dr-color:disabled { opacity: 0.35; cursor: not-allowed; }
.dr-mini { padding: 5px 8px; border-radius: 6px; border: none; cursor: pointer;
  background: rgba(255,255,255,0.08); color: #f1ece8; font-size: 0.72rem; }
.dr-mini:disabled { opacity: 0.35; cursor: not-allowed; }
.dr-hint { font-size: 0.68rem; color: #8c807b; text-align: center; margin-top: 4px; }
`;
    document.head.appendChild(style);
}
