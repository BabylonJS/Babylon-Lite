// Thin PropertyLine components, re-authored against Fluent UI v9 directly.
//
// These mirror the *pattern* of Babylon's @babylonjs/shared-ui-components
// (a label + control row, plus typed variants) but are re-implemented here so
// the Lite playground depends only on React + Fluent — not on the shared-ui
// package, which is unpublished-entry (`main` missing from its tarball), has
// undeclared Fluent peers, and couples many of its controls to @babylonjs/core.
// Keeping our own thin layer avoids dragging full Babylon into a Lite app while
// matching the same look (Fluent 2 `webDarkTheme`) and layout metrics.
import type { ReactNode } from "react";
import {
    Body1,
    Button,
    Dropdown,
    Option,
    Slider,
    Switch,
    makeStyles,
    tokens,
} from "@fluentui/react-components";

// Layout metrics mirror shared-ui-components' fluent/primitives/utils.ts
// (36px line height, ~150px value column) so the panel reads like Babylon's.
const useStyles = makeStyles({
    line: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        columnGap: tokens.spacingHorizontalM,
        minHeight: "36px",
        paddingTop: tokens.spacingVerticalXS,
        paddingBottom: tokens.spacingVerticalXS,
    },
    label: {
        display: "flex",
        flexDirection: "column",
        minWidth: "50px",
        rowGap: "2px",
    },
    description: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    control: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flex: "0 0 auto",
        minWidth: "150px",
    },
    sliderControl: {
        columnGap: tokens.spacingHorizontalS,
    },
    sliderValue: {
        minWidth: "34px",
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        color: tokens.colorNeutralForeground2,
    },
});

export interface PropertyLineProps {
    label: string;
    description?: string;
    children: ReactNode;
}

/** Base row: a label (with optional description) on the left, a control on the right. */
export function PropertyLine(props: PropertyLineProps) {
    const styles = useStyles();
    return (
        <div className={styles.line}>
            <div className={styles.label}>
                <Body1>{props.label}</Body1>
                {props.description ? <span className={styles.description}>{props.description}</span> : null}
            </div>
            <div className={styles.control}>{props.children}</div>
        </div>
    );
}

export interface SwitchPropertyLineProps {
    label: string;
    description?: string;
    value: boolean;
    onChange: (value: boolean) => void;
}

export function SwitchPropertyLine(props: SwitchPropertyLineProps) {
    return (
        <PropertyLine label={props.label} description={props.description}>
            <Switch checked={props.value} onChange={(_, data) => props.onChange(data.checked)} />
        </PropertyLine>
    );
}

export interface DropdownOption {
    value: string;
    label: string;
}

export interface DropdownPropertyLineProps {
    label: string;
    description?: string;
    value: string;
    options: DropdownOption[];
    onChange: (value: string) => void;
}

export function DropdownPropertyLine(props: DropdownPropertyLineProps) {
    const selected = props.options.find((option) => option.value === props.value);
    return (
        <PropertyLine label={props.label} description={props.description}>
            <Dropdown
                value={selected?.label ?? ""}
                selectedOptions={[props.value]}
                onOptionSelect={(_, data) => {
                    if (data.optionValue !== undefined) {
                        props.onChange(data.optionValue);
                    }
                }}
            >
                {props.options.map((option) => (
                    <Option key={option.value} value={option.value}>
                        {option.label}
                    </Option>
                ))}
            </Dropdown>
        </PropertyLine>
    );
}

export interface SyncedSliderPropertyLineProps {
    label: string;
    description?: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
}

/** A slider whose current value is echoed by a numeric readout, à la shared-ui. */
export function SyncedSliderPropertyLine(props: SyncedSliderPropertyLineProps) {
    const styles = useStyles();
    return (
        <PropertyLine label={props.label} description={props.description}>
            <div className={`${styles.control} ${styles.sliderControl}`}>
                <Slider
                    min={props.min}
                    max={props.max}
                    step={props.step ?? 1}
                    value={props.value}
                    onChange={(_, data) => props.onChange(data.value)}
                />
                <span className={styles.sliderValue}>{props.value}</span>
            </div>
        </PropertyLine>
    );
}

export interface ButtonLineProps {
    label: string;
    onClick: () => void;
}

/** A full-width action button row (Babylon shared-ui calls this a ButtonLine). */
export function ButtonLine(props: ButtonLineProps) {
    return (
        <Button appearance="secondary" onClick={props.onClick}>
            {props.label}
        </Button>
    );
}
