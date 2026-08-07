import * as Dialog from "@radix-ui/react-dialog";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "../lib/api";

export type AppConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type AppAlertOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
};

export type AppPromptOptions = {
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Pending =
  | { kind: "confirm"; options: AppConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; options: AppAlertOptions; resolve: () => void }
  | { kind: "prompt"; options: AppPromptOptions; resolve: (v: string | null) => void };

type AppDialogContextValue = {
  confirm: (options: AppConfirmOptions) => Promise<boolean>;
  alert: (options: AppAlertOptions) => Promise<void>;
  prompt: (options: AppPromptOptions) => Promise<string | null>;
};

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

/**
 * App-wide confirm / alert dialogs — replaces native `confirm()` and
 * `alert()` so prompts never show the browser's "localhost says:" chrome.
 */
export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [promptValue, setPromptValue] = useState("");

  const confirm = useCallback((options: AppConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ kind: "confirm", options, resolve });
    });
  }, []);

  const alert = useCallback((options: AppAlertOptions) => {
    return new Promise<void>((resolve) => {
      setPending({ kind: "alert", options, resolve });
    });
  }, []);

  const prompt = useCallback((options: AppPromptOptions) => {
    setPromptValue(options.defaultValue ?? "");
    return new Promise<string | null>((resolve) => {
      setPending({ kind: "prompt", options, resolve });
    });
  }, []);

  const finish = (result: boolean | string | null) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(result === true);
    else if (pending.kind === "alert") pending.resolve();
    else pending.resolve(typeof result === "string" ? result : null);
    setPending(null);
    setPromptValue("");
  };

  const isConfirm = pending?.kind === "confirm";
  const isPrompt = pending?.kind === "prompt";
  const options = pending?.options;
  const confirmOpts = isConfirm ? (options as AppConfirmOptions) : null;
  const alertOpts = pending?.kind === "alert" ? (options as AppAlertOptions) : null;
  const promptOpts = isPrompt ? (options as AppPromptOptions) : null;

  return (
    <AppDialogContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-[101] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl outline-none"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              cancelRef.current?.focus();
            }}
          >
            {options ? (
              <>
                <Dialog.Title className="text-base font-semibold text-wp-ink">
                  {options.title}
                </Dialog.Title>
                {options.description ? (
                  <Dialog.Description className="mt-2 whitespace-pre-line text-sm text-wp-slate">
                    {options.description}
                  </Dialog.Description>
                ) : null}
                {isPrompt ? (
                  <input
                    className="input mt-3 w-full text-sm"
                    value={promptValue}
                    onChange={(e) => setPromptValue(e.target.value)}
                    placeholder={promptOpts?.placeholder}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finish(promptValue);
                    }}
                  />
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                  {isConfirm || isPrompt ? (
                    <>
                      <button
                        ref={cancelRef}
                        type="button"
                        className="btn-primary"
                        onClick={() => finish(false)}
                      >
                        {isPrompt
                          ? (promptOpts?.cancelLabel ?? "Cancel")
                          : (confirmOpts?.cancelLabel ?? "Cancel")}
                      </button>
                      <button
                        type="button"
                        className={
                          confirmOpts?.destructive
                            ? "btn-secondary text-red-600 hover:bg-red-50"
                            : "btn-secondary"
                        }
                        onClick={() => {
                          if (isPrompt) finish(promptValue);
                          else finish(true);
                        }}
                      >
                        {isPrompt
                          ? (promptOpts?.confirmLabel ?? "OK")
                          : (confirmOpts?.confirmLabel ?? "Confirm")}
                      </button>
                    </>
                  ) : (
                    <button
                      ref={cancelRef}
                      type="button"
                      className="btn-primary"
                      onClick={() => finish(true)}
                    >
                      {alertOpts?.confirmLabel ?? "OK"}
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AppDialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogContextValue {
  const ctx = useContext(AppDialogContext);
  if (!ctx) {
    throw new Error("useAppDialog must be used within AppDialogProvider");
  }
  return ctx;
}

export function appDialogErrorMessage(
  err: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
