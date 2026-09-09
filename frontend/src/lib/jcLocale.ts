import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createCookieStorage } from "./cookieStorage";

/** Locales offered in the Waypoint navbar JC switcher. */
export const JC_LOCALES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
] as const;

export type JcLocaleCode = (typeof JC_LOCALES)[number]["code"];

const ALLOWED = new Set<string>(JC_LOCALES.map((l) => l.code));

function normalizeLocale(raw: string | null | undefined): JcLocaleCode {
  const code = (raw ?? "").trim().toLowerCase();
  if (ALLOWED.has(code)) return code as JcLocaleCode;
  // Accept BCP-47 prefixes (e.g. en-US → en).
  const base = code.split("-")[0];
  if (ALLOWED.has(base)) return base as JcLocaleCode;
  return "en";
}

function envDefault(): JcLocaleCode {
  return normalizeLocale(
    (import.meta.env.VITE_JIFFCONTENT_LOCALE as string | undefined)?.trim(),
  );
}

type JcLocaleState = {
  locale: JcLocaleCode;
  setLocale: (locale: string) => void;
};

export const useJcLocaleStore = create<JcLocaleState>()(
  persist(
    (set) => ({
      locale: envDefault(),
      setLocale: (locale) => set({ locale: normalizeLocale(locale) }),
    }),
    {
      name: "waypoint.jcLocale",
      storage: createJSONStorage(() => createCookieStorage()),
      partialize: (s) => ({ locale: s.locale }),
    },
  ),
);

export function getJcLocale(): JcLocaleCode {
  return useJcLocaleStore.getState().locale;
}
