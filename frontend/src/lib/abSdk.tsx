import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { init, PREVIEW_CHANGE_EVENT, type AbSdk, type Assignment, type ExposureEvent } from "@ziffsplit/sdk";

interface AbContextValue {
  ready: boolean;
  error: string | null;
  sdk: AbSdk | null;
  configVersion: number | null;
  /** Bumps when admin preview overrides change so consumers re-render. */
  previewRevision: number;
  getAssignment: (experimentKey: string) => Assignment | null;
  getContent: (experimentKey: string) => string | null;
  getAssignmentByContainer: (containerKey: string) => Assignment | null;
  getContentByContainer: (containerKey: string) => string | null;
  lastExposure: ExposureEvent | null;
}

const AbContext = createContext<AbContextValue | null>(null);

const siteKey = import.meta.env.VITE_AB_SITE_KEY as string | undefined;
const apiBaseUrl =
  (import.meta.env.VITE_AB_API_BASE as string | undefined) ?? "http://localhost:4100";

export function AbSdkProvider({
  children,
  userId,
}: {
  children: ReactNode;
  /** Stable Waypoint user id for bucketing; falls back to SDK anon id. */
  userId?: string | null;
}) {
  const [sdk, setSdk] = useState<AbSdk | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configVersion, setConfigVersion] = useState<number | null>(null);
  const [lastExposure, setLastExposure] = useState<ExposureEvent | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);

  useEffect(() => {
    function onPreviewChange() {
      setPreviewRevision((n) => n + 1);
    }
    window.addEventListener(PREVIEW_CHANGE_EVENT, onPreviewChange);
    return () => window.removeEventListener(PREVIEW_CHANGE_EVENT, onPreviewChange);
  }, []);

  useEffect(() => {
    if (!siteKey) {
      setReady(true);
      setError(null);
      setSdk(null);
      setConfigVersion(null);
      return;
    }

    let cancelled = false;
    const instance = init({
      siteKey,
      apiBaseUrl,
      pollIntervalMs: 60_000,
      getUserId: () => userId ?? null,
    });

    instance.onExposure((event) => {
      setLastExposure(event);
      console.info("[ziffsplit] exposure", event);
    });

    setSdk(instance);
    setReady(false);
    setError(null);

    // Console helpers: window.__ziffsplit.listAssignments() / clearAssignments()
    if (typeof window !== "undefined") {
      (window as Window & { __ziffsplit?: AbSdk }).__ziffsplit = instance;
    }

    instance
      .init()
      .then(() => {
        if (cancelled) return;
        setConfigVersion(instance.config?.version ?? 0);
        setReady(true);
        setError(null);
        console.info("[ziffsplit] ready", {
          siteKey,
          apiBaseUrl,
          version: instance.config?.version,
          experiments: instance.config?.experiments?.map((e) => e.key),
          console:
            "window.__ziffsplit.listAssignments() / getAssignments() / clearAssignments({ rebucket: true })",
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "AB SDK init failed";
        setError(message);
        setReady(true);
        console.error("[ziffsplit] init failed", err);
      });

    return () => {
      cancelled = true;
      instance.destroy();
      if (typeof window !== "undefined") {
        const w = window as Window & { __ziffsplit?: AbSdk };
        if (w.__ziffsplit === instance) delete w.__ziffsplit;
      }
    };
  }, [userId]);

  const value = useMemo<AbContextValue>(
    () => ({
      ready,
      error,
      sdk,
      configVersion,
      previewRevision,
      getAssignment: (experimentKey) => sdk?.getAssignment(experimentKey) ?? null,
      getContent: (experimentKey) => sdk?.getContent(experimentKey) ?? null,
      getAssignmentByContainer: (containerKey) =>
        sdk?.getAssignmentByContainer(containerKey) ?? null,
      getContentByContainer: (containerKey) =>
        sdk?.getContentByContainer(containerKey) ?? null,
      lastExposure,
    }),
    [ready, error, sdk, configVersion, previewRevision, lastExposure],
  );

  return <AbContext.Provider value={value}>{children}</AbContext.Provider>;
}

export function useAbSdk(): AbContextValue {
  const ctx = useContext(AbContext);
  if (!ctx) {
    throw new Error("useAbSdk must be used within AbSdkProvider");
  }
  return ctx;
}

export function isAbSdkConfigured(): boolean {
  return Boolean(siteKey);
}

export function getAbApiBaseUrl(): string {
  return apiBaseUrl;
}

