import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { init, type AbSdk, type Assignment, type ExposureEvent } from "@ziffsplit/sdk";

interface AbContextValue {
  ready: boolean;
  error: string | null;
  sdk: AbSdk | null;
  configVersion: number | null;
  isOn: (flagKey: string) => boolean;
  getAssignment: (experimentKey: string) => Assignment | null;
  getContent: (experimentKey: string) => string | null;
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
          flags: instance.config?.flags?.map((f) => f.key),
          experiments: instance.config?.experiments?.map((e) => e.key),
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
    };
  }, [userId]);

  const value = useMemo<AbContextValue>(
    () => ({
      ready,
      error,
      sdk,
      configVersion,
      // configVersion in deps forces fresh closures after config arrives
      isOn: (flagKey) => sdk?.isOn(flagKey) ?? false,
      getAssignment: (experimentKey) => sdk?.getAssignment(experimentKey) ?? null,
      getContent: (experimentKey) => sdk?.getContent(experimentKey) ?? null,
      lastExposure,
    }),
    [ready, error, sdk, configVersion, lastExposure],
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
