/**
 * Wire types for the public config payload.
 * Regenerate via: npm run sync-contracts
 */
interface ConfigPayload {
    siteKey: string;
    version: number;
    publishedAt: string | null;
    experiments: ExperimentConfig[];
    identity: IdentityConfigMeta | null;
}
interface ExperimentConfig {
    key: string;
    containerKey: string;
    deliveryMode: "embedded" | "api";
    variants: ExperimentVariantConfig[];
    primaryKpi?: string;
    secondaryKpis?: string[];
    targetingRules: unknown[];
    rolloutPercent: number;
}
interface ExperimentVariantConfig {
    key: string;
    /** Human-friendly label; bucketing and sticky assignment use `key`. */
    displayName?: string;
    weight: number;
    contentSource: "authored" | "code";
    authoredContent?: string;
    codeVariantKey?: string;
}
interface IdentityConfigMeta {
    strategy: "cookie" | "globalVar" | "localStorage";
    config: Record<string, unknown>;
}
interface ExposureEvent {
    experimentKey: string;
    variantKey: string;
    containerKey: string;
    userId?: string;
    anonId?: string;
    timestamp: string;
    deliveryMode: "embedded" | "api";
    contentSource: "authored" | "code";
    primaryKpi?: string;
    siteKey: string;
    configVersion: number;
}
interface InitOptions {
    siteKey: string;
    apiBaseUrl?: string;
    identity?: IdentityConfigMeta;
    getUserId?: () => string | null;
    attributes?: Record<string, unknown>;
    pollIntervalMs?: number;
}
interface Assignment {
    experimentKey: string;
    variantKey: string;
    variantDisplayName?: string;
    containerKey: string;
    deliveryMode: "embedded" | "api";
    contentSource: "authored" | "code";
    authoredContent?: string;
    codeVariantKey?: string;
    primaryKpi?: string;
}
interface AbSdk {
    readonly siteKey: string;
    readonly config: ConfigPayload | null;
    init(): Promise<void>;
    getAssignment(experimentKey: string): Assignment | null;
    getContent(experimentKey: string): string | null;
    /** Evaluate every live experiment in the current config (fires exposures). */
    getAssignments(): Assignment[];
    /** Sticky assignments currently stored for this browser (does not evaluate or expose). */
    listAssignments(): Array<{
        experimentKey: string;
        variantKey: string;
    }>;
    /**
     * Clear sticky assignments so the next evaluation writes a fresh bucket.
     * Pass `{ rebucket: true }` to also rotate a debug salt so the same user
     * can land in a different variant (testing only — production traffic
     * never sets this salt).
     */
    clearAssignments(options?: {
        rebucket?: boolean;
    }): void;
    /**
     * Force a variant (and optional authored content) for admin/live preview.
     * Only active when the page URL includes `zs_preview=1`.
     */
    setPreviewOverride(override: {
        experimentKey: string;
        variantKey: string;
        authoredContent?: string;
    } | null): void;
    onExposure(callback: (event: ExposureEvent) => void): void;
    destroy(): void;
}

declare const PREVIEW_MESSAGE_TYPE = "ziffsplit:set-preview";
declare const PREVIEW_CHANGE_EVENT = "ziffsplit:preview-change";
type PreviewOverride = {
    experimentKey: string;
    variantKey: string;
    /** When set, getContent() returns this instead of published authored content. */
    authoredContent?: string;
};
declare function encodePreviewHash(override: PreviewOverride): string;
/** Build a preview URL for embedding / opening a host page. */
declare function buildPreviewUrl(pageUrl: string, override: PreviewOverride, options?: {
    includeContentInHash?: boolean;
}): string;
declare function postPreviewOverride(target: Window, override: PreviewOverride, targetOrigin?: string): void;

declare function init(options: InitOptions): AbSdk;

export { type AbSdk, type Assignment, type ConfigPayload, type ExperimentConfig, type ExposureEvent, type InitOptions, PREVIEW_CHANGE_EVENT, PREVIEW_MESSAGE_TYPE, buildPreviewUrl, encodePreviewHash, init, postPreviewOverride };
