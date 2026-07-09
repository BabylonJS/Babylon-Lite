// The playground toolbar: a Fluent UI React island that replaces the hand-rolled
// <header> chrome. It renders the brand, the mobile Code/Scene tab toggle, and
// the action cluster (New, examples, engine version, save, download, run, open
// in full, settings).
//
// All behaviour still lives in main.ts — this component is purely presentational
// and is driven through the ToolbarActions callbacks and a ToolbarModel that
// main.ts pushes in via the handle's update(). On narrow screens the actions
// collapse into a hamburger Popover, mirroring the previous CSS-only layout.
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    Button,
    Dropdown,
    FluentProvider,
    Menu,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Option,
    Popover,
    PopoverSurface,
    PopoverTrigger,
    SplitButton,
    Tab,
    TabList,
    Tooltip,
    makeStyles,
    tokens,
    webDarkTheme,
} from "@fluentui/react-components";
import type { MenuButtonProps } from "@fluentui/react-components";
import {
    ArrowDownload20Regular,
    DocumentAdd20Regular,
    Navigation20Regular,
    Open20Regular,
    Play20Filled,
    Save20Regular,
    Settings20Regular,
} from "@fluentui/react-icons";

export type ViewMode = "code" | "scene";

export interface LabeledValue {
    value: string;
    label: string;
}

/** Reactive state main.ts pushes into the toolbar. */
export interface ToolbarModel {
    mode: ViewMode;
    version: string;
    versions: LabeledValue[];
    examples: LabeledValue[];
    /** The currently-selected example id, or null when on a fresh/loaded project. */
    selectedExample: string | null;
    /** True while a run is in flight (disables Run + Save). */
    running: boolean;
    /** Non-null when embedded in a host page; hides most chrome. */
    embedMode: "runner" | "split" | null;
}

/** Behaviour callbacks — all implemented in main.ts. */
export interface ToolbarActions {
    run(): void;
    newProject(): void;
    save(): void;
    saveWithDetails(): void;
    download(): void;
    openInFull(): void;
    openSettings(): void;
    setMode(mode: ViewMode): void;
    setVersion(version: string): void;
    loadExample(id: string): void;
}

export interface ToolbarHandle {
    update(patch: Partial<ToolbarModel>): void;
    unmount(): void;
}

const useStyles = makeStyles({
    bar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        width: "100%",
    },
    actionsRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
    },
    actionsColumn: {
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: tokens.spacingVerticalS,
        minWidth: "13rem",
    },
    fullWidth: {
        width: "100%",
        justifyContent: "flex-start",
    },
});

function useIsMobile(): boolean {
    const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
    useEffect(() => {
        const query = window.matchMedia("(max-width: 768px)");
        const onChange = (): void => setIsMobile(query.matches);
        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
    }, []);
    return isMobile;
}

function Brand({ compact }: { compact: boolean }) {
    return (
        <div className="brand">
            <img className="brand-logo" src="/favicon.svg" alt="" width={28} height={28} />
            {!compact ? (
                <>
                    <span className="brand-text">
                        Babylon <span>Lite</span> Playground
                    </span>
                    <span className="beta-badge" title="This playground is in beta — expect rough edges">
                        Beta
                    </span>
                </>
            ) : null}
        </div>
    );
}

interface ActionsProps {
    model: ToolbarModel;
    actions: ToolbarActions;
    /** Column layout (mobile popover) shows text labels; the row layout is icon-only. */
    stacked: boolean;
}

/** The shared action controls, laid out either as an icon row (desktop) or a labelled column (mobile). */
function Actions({ model, actions, stacked }: ActionsProps) {
    const styles = useStyles();
    const embedded = model.embedMode !== null;
    const buttonClass = stacked ? styles.fullWidth : undefined;
    // In stacked (mobile) mode, buttons carry a text label; on the desktop row they
    // are icon-only with a tooltip.
    const label = (icon: JSX.Element, text: string): { icon: JSX.Element; children?: string } =>
        stacked ? { icon, children: text } : { icon };

    const iconButton = (icon: JSX.Element, text: string, onClick: () => void, disabled?: boolean) => {
        const button = (
            <Button appearance="subtle" className={buttonClass} disabled={disabled} aria-label={text} onClick={onClick} {...label(icon, text)} />
        );
        return stacked ? button : <Tooltip content={text} relationship="label">{button}</Tooltip>;
    };

    // The embedded host only exposes Run + Open-in-playground.
    if (embedded) {
        return (
            <div className={stacked ? styles.actionsColumn : styles.actionsRow}>
                <Button
                    appearance="primary"
                    className={buttonClass}
                    icon={<Play20Filled />}
                    disabled={model.running}
                    onClick={actions.run}
                >
                    {stacked ? "Run" : undefined}
                </Button>
                {iconButton(<Open20Regular />, "Open in Playground", actions.openInFull)}
            </div>
        );
    }

    return (
        <div className={stacked ? styles.actionsColumn : styles.actionsRow}>
            {iconButton(<DocumentAdd20Regular />, "New project", actions.newProject)}

            <Dropdown
                className={buttonClass}
                aria-label="Examples"
                placeholder="Examples"
                value={model.examples.find((e) => e.value === model.selectedExample)?.label ?? ""}
                selectedOptions={model.selectedExample ? [model.selectedExample] : []}
                onOptionSelect={(_, data) => data.optionValue && actions.loadExample(data.optionValue)}
            >
                {model.examples.map((example) => (
                    <Option key={example.value} value={example.value}>
                        {example.label}
                    </Option>
                ))}
            </Dropdown>

            <Dropdown
                className={buttonClass}
                aria-label="Engine version"
                value={model.versions.find((v) => v.value === model.version)?.label ?? ""}
                selectedOptions={[model.version]}
                onOptionSelect={(_, data) => data.optionValue && actions.setVersion(data.optionValue)}
            >
                {model.versions.map((version) => (
                    <Option key={version.value} value={version.value}>
                        {version.label}
                    </Option>
                ))}
            </Dropdown>

            <Menu positioning="below-end">
                <MenuTrigger disableButtonEnhancement>
                    {(triggerProps: MenuButtonProps) => (
                        <SplitButton
                            className={buttonClass}
                            menuButton={triggerProps}
                            primaryActionButton={{ onClick: actions.save, disabled: model.running }}
                            icon={<Save20Regular />}
                            aria-label="Save and copy link"
                        >
                            {stacked ? "Save & copy link" : undefined}
                        </SplitButton>
                    )}
                </MenuTrigger>
                <MenuPopover>
                    <MenuList>
                        <MenuItem onClick={actions.saveWithDetails}>Save with details…</MenuItem>
                    </MenuList>
                </MenuPopover>
            </Menu>

            {iconButton(<ArrowDownload20Regular />, "Download", actions.download)}

            <Button
                appearance="primary"
                className={buttonClass}
                icon={<Play20Filled />}
                disabled={model.running}
                onClick={actions.run}
            >
                {stacked ? "Run" : undefined}
            </Button>

            {iconButton(<Settings20Regular />, "Settings", actions.openSettings)}
        </div>
    );
}

function AppToolbar({ model, actions }: { model: ToolbarModel; actions: ToolbarActions }) {
    const styles = useStyles();
    const isMobile = useIsMobile();
    const embedded = model.embedMode !== null;
    // The Code/Scene toggle only matters when the panes stack (mobile, non-embed).
    const showModeToggle = isMobile && !embedded;

    return (
        <div className={styles.bar}>
            <Brand compact={isMobile} />

            {showModeToggle ? (
                <TabList
                    selectedValue={model.mode}
                    onTabSelect={(_, data) => actions.setMode(data.value as ViewMode)}
                    aria-label="View mode"
                >
                    <Tab value="code">Code</Tab>
                    <Tab value="scene">Scene</Tab>
                </TabList>
            ) : null}

            {isMobile && !embedded ? (
                <Popover positioning="below-end" trapFocus>
                    <PopoverTrigger disableButtonEnhancement>
                        <Button appearance="subtle" icon={<Navigation20Regular />} aria-label="Menu" />
                    </PopoverTrigger>
                    <PopoverSurface>
                        <Actions model={model} actions={actions} stacked />
                    </PopoverSurface>
                </Popover>
            ) : (
                <Actions model={model} actions={actions} stacked={false} />
            )}
        </div>
    );
}

/** Mount the toolbar into `container`, returning a handle to push state + unmount. */
export function mountToolbar(container: HTMLElement, actions: ToolbarActions, initial: ToolbarModel): ToolbarHandle {
    const root: Root = createRoot(container);
    let current = initial;

    function render(): void {
        root.render(
            <StrictMode>
                <FluentProvider theme={webDarkTheme} className="app-chrome-provider">
                    <AppToolbar model={current} actions={actions} />
                </FluentProvider>
            </StrictMode>,
        );
    }

    render();

    return {
        update: (patch) => {
            current = { ...current, ...patch };
            render();
        },
        unmount: () => root.unmount(),
    };
}
