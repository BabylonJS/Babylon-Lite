// The playground Settings panel: a self-contained React + Fluent island.
//
// This is the one React root in an otherwise vanilla-TS app. main.ts mounts it
// into the drawer container on first open; everything Fluent (theme, styling via
// Griffel, components) lives inside this <FluentProvider> boundary so the rest of
// the app is unaffected. State lives in the shared SettingsStore, so toggles here
// drive the real editor / runner behaviour in main.ts.
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    Accordion,
    AccordionHeader,
    AccordionItem,
    AccordionPanel,
    Button,
    FluentProvider,
    Subtitle2,
    Divider,
    makeStyles,
    tokens,
    webDarkTheme,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { EditorTheme, SettingsStore } from "../settings";
import {
    ButtonLine,
    DropdownPropertyLine,
    SwitchPropertyLine,
    SyncedSliderPropertyLine,
} from "./property-lines";

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: tokens.spacingHorizontalL,
        paddingRight: tokens.spacingHorizontalS,
        paddingTop: tokens.spacingVerticalM,
        paddingBottom: tokens.spacingVerticalM,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    body: {
        flex: "1 1 auto",
        overflowY: "auto",
        paddingLeft: tokens.spacingHorizontalM,
        paddingRight: tokens.spacingHorizontalM,
        paddingBottom: tokens.spacingVerticalL,
    },
    footer: {
        padding: tokens.spacingHorizontalM,
        borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
});

const THEME_OPTIONS = [
    { value: "vs-dark", label: "Dark" },
    { value: "hc-black", label: "High contrast" },
];

interface SettingsPanelProps {
    store: SettingsStore;
    onClose: () => void;
}

function SettingsPanel({ store, onClose }: SettingsPanelProps) {
    const styles = useStyles();
    const [settings, setSettings] = useState(store.get());

    // Mirror the store into local state so external changes (e.g. reset) re-render.
    useEffect(() => store.subscribe(setSettings), [store]);

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <Subtitle2>Playground settings</Subtitle2>
                <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close settings" onClick={onClose} />
            </div>
            <div className={styles.body}>
                <Accordion multiple collapsible defaultOpenItems={["preview", "editor", "behavior"]}>
                    <AccordionItem value="preview">
                        <AccordionHeader>Preview</AccordionHeader>
                        <AccordionPanel>
                            <SwitchPropertyLine
                                label="Show FPS"
                                description="Overlay the live frame rate"
                                value={settings.showFps}
                                onChange={(showFps) => store.set({ showFps })}
                            />
                        </AccordionPanel>
                    </AccordionItem>

                    <AccordionItem value="editor">
                        <AccordionHeader>Editor</AccordionHeader>
                        <AccordionPanel>
                            <SyncedSliderPropertyLine
                                label="Font size"
                                value={settings.editorFontSize}
                                min={10}
                                max={24}
                                onChange={(editorFontSize) => store.set({ editorFontSize })}
                            />
                            <SwitchPropertyLine
                                label="Word wrap"
                                value={settings.wordWrap}
                                onChange={(wordWrap) => store.set({ wordWrap })}
                            />
                            <SwitchPropertyLine
                                label="Minimap"
                                value={settings.minimap}
                                onChange={(minimap) => store.set({ minimap })}
                            />
                            <DropdownPropertyLine
                                label="Theme"
                                value={settings.editorTheme}
                                options={THEME_OPTIONS}
                                onChange={(value) => store.set({ editorTheme: value as EditorTheme })}
                            />
                        </AccordionPanel>
                    </AccordionItem>

                    <AccordionItem value="behavior">
                        <AccordionHeader>Behavior</AccordionHeader>
                        <AccordionPanel>
                            <SwitchPropertyLine
                                label="Auto-run on edit"
                                description="Re-run shortly after you stop typing"
                                value={settings.autoRun}
                                onChange={(autoRun) => store.set({ autoRun })}
                            />
                            <SyncedSliderPropertyLine
                                label="Auto-run delay"
                                description="Milliseconds"
                                value={settings.autoRunDelay}
                                min={200}
                                max={2000}
                                step={100}
                                onChange={(autoRunDelay) => store.set({ autoRunDelay })}
                            />
                        </AccordionPanel>
                    </AccordionItem>
                </Accordion>
            </div>
            <div className={styles.footer}>
                <Divider style={{ marginBottom: tokens.spacingVerticalM }} />
                <ButtonLine label="Reset to defaults" onClick={() => store.reset()} />
            </div>
        </div>
    );
}

/**
 * Mount the settings panel into `container`. Returns an unmount function that
 * tears the React root down (called if the drawer is ever destroyed).
 */
export function mountSettingsPanel(container: HTMLElement, store: SettingsStore, onClose: () => void): () => void {
    const root: Root = createRoot(container);
    root.render(
        <StrictMode>
            <FluentProvider theme={webDarkTheme} className="settings-fluent-provider">
                <SettingsPanel store={store} onClose={onClose} />
            </FluentProvider>
        </StrictMode>,
    );
    return () => root.unmount();
}
