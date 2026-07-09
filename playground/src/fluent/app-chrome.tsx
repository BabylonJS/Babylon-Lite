// The app-chrome React root: a single Fluent island that owns the pieces of the
// playground shell that have migrated to Fluent UI. It currently renders the
// toast surface and the "Save snippet" dialog; the toolbar folds in here too.
//
// The rest of the app is still vanilla TS (main.ts owns all logic: run, save,
// routing, embed, editor, runner). main.ts drives this island imperatively
// through the AppChromeHandle returned by mountAppChrome — so vanilla logic can
// "call into" Fluent UI without adopting React for the whole app at once.
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    Button,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Field,
    FluentProvider,
    Input,
    Textarea,
    Toast,
    Toaster,
    ToastTitle,
    useId,
    useToastController,
    webDarkTheme,
} from "@fluentui/react-components";

/** The editable fields of the save dialog. */
export interface SnippetDialogValues {
    name: string;
    description: string;
    tags: string;
}

/** Imperative handle main.ts uses to drive the chrome from vanilla code. */
export interface AppChromeHandle {
    /** Show a transient notification, replacing any current one. */
    showToast(text: string, isError?: boolean): void;
    /** Show a persistent progress notification (e.g. "Saving…"), replacing any current one. */
    showProgress(text: string): void;
    /** Dismiss the current notification. */
    dismissToast(): void;
    /** Open the save dialog seeded with `initial`; `onConfirm` fires on submit. */
    openSaveDialog(initial: SnippetDialogValues, onConfirm: (values: SnippetDialogValues) => void): void;
    /** Tear the React root down. */
    unmount(): void;
}

// A tiny bridge object: the React components fill in these callbacks on mount,
// and the handle returned to main.ts forwards to them. Calls made before the
// first commit (there shouldn't be any in practice) are silently dropped.
interface ChromeBridge {
    showToast?: (text: string, isError: boolean) => void;
    showProgress?: (text: string) => void;
    dismissToast?: () => void;
    openSaveDialog?: (initial: SnippetDialogValues, onConfirm: (values: SnippetDialogValues) => void) => void;
}

interface SaveDialogState {
    open: boolean;
    values: SnippetDialogValues;
    onConfirm: (values: SnippetDialogValues) => void;
}

const EMPTY_VALUES: SnippetDialogValues = { name: "", description: "", tags: "" };

function AppChrome({ bridge }: { bridge: ChromeBridge }) {
    const toasterId = useId("pg-toaster");
    const { dispatchToast, dismissAllToasts } = useToastController(toasterId);
    const [dialog, setDialog] = useState<SaveDialogState>({ open: false, values: EMPTY_VALUES, onConfirm: () => {} });

    // Wire the imperative bridge once mounted.
    useEffect(() => {
        const show = (text: string, isError: boolean): void => {
            dismissAllToasts();
            dispatchToast(
                <Toast>
                    <ToastTitle>{text}</ToastTitle>
                </Toast>,
                { intent: isError ? "error" : "success", timeout: isError ? 4000 : 3000 },
            );
        };
        bridge.showToast = show;
        bridge.showProgress = (text: string): void => {
            dismissAllToasts();
            dispatchToast(
                <Toast>
                    <ToastTitle>{text}</ToastTitle>
                </Toast>,
                { intent: "info", timeout: -1 },
            );
        };
        bridge.dismissToast = (): void => dismissAllToasts();
        bridge.openSaveDialog = (initial, onConfirm): void => setDialog({ open: true, values: initial, onConfirm });
        return () => {
            bridge.showToast = undefined;
            bridge.showProgress = undefined;
            bridge.dismissToast = undefined;
            bridge.openSaveDialog = undefined;
        };
    }, [bridge, dispatchToast, dismissAllToasts]);

    const patch = (part: Partial<SnippetDialogValues>): void =>
        setDialog((prev) => ({ ...prev, values: { ...prev.values, ...part } }));

    const close = (): void => setDialog((prev) => ({ ...prev, open: false }));

    const submit = (event: React.FormEvent): void => {
        event.preventDefault();
        dialog.onConfirm({
            name: dialog.values.name.trim(),
            description: dialog.values.description.trim(),
            tags: dialog.values.tags.trim(),
        });
        close();
    };

    return (
        <>
            <Toaster toasterId={toasterId} position="bottom" />
            <Dialog open={dialog.open} onOpenChange={(_, data) => setDialog((prev) => ({ ...prev, open: data.open }))}>
                <DialogSurface>
                    <form onSubmit={submit}>
                        <DialogBody>
                            <DialogTitle>Save snippet</DialogTitle>
                            <DialogContent className="save-dialog-content">
                                <Field label="Title">
                                    <Input
                                        value={dialog.values.name}
                                        autoComplete="off"
                                        placeholder="My Lite scene"
                                        onChange={(_, data) => patch({ name: data.value })}
                                    />
                                </Field>
                                <Field label="Description">
                                    <Textarea
                                        value={dialog.values.description}
                                        rows={3}
                                        placeholder="What does this show?"
                                        onChange={(_, data) => patch({ description: data.value })}
                                    />
                                </Field>
                                <Field label="Tags">
                                    <Input
                                        value={dialog.values.tags}
                                        autoComplete="off"
                                        placeholder="comma, separated"
                                        onChange={(_, data) => patch({ tags: data.value })}
                                    />
                                </Field>
                            </DialogContent>
                            <DialogActions>
                                <Button appearance="secondary" type="button" onClick={close}>
                                    Cancel
                                </Button>
                                <Button appearance="primary" type="submit">
                                    Save &amp; copy link
                                </Button>
                            </DialogActions>
                        </DialogBody>
                    </form>
                </DialogSurface>
            </Dialog>
        </>
    );
}

/** Mount the app-chrome root into `container`, returning an imperative handle. */
export function mountAppChrome(container: HTMLElement): AppChromeHandle {
    const bridge: ChromeBridge = {};
    const root: Root = createRoot(container);
    root.render(
        <StrictMode>
            <FluentProvider theme={webDarkTheme} className="app-chrome-provider">
                <AppChrome bridge={bridge} />
            </FluentProvider>
        </StrictMode>,
    );
    return {
        showToast: (text, isError = false) => bridge.showToast?.(text, isError),
        showProgress: (text) => bridge.showProgress?.(text),
        dismissToast: () => bridge.dismissToast?.(),
        openSaveDialog: (initial, onConfirm) => bridge.openSaveDialog?.(initial, onConfirm),
        unmount: () => root.unmount(),
    };
}
