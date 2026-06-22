/// <reference types="vite/client" />

// Type the app's own env vars so reads are `string | undefined` instead of `any`
// (Vite's ImportMetaEnv has a `[key: string]: any` index signature).
interface ImportMetaEnv {
  // Optional browser-direct override. Leave empty for local dev so the browser
  // calls the current frontend origin and Vite proxies /api to the configured target.
  readonly VITE_ADMIN_API_BASE_URL?: string;
}

declare const __PATCHPILOT_ADMIN_API_DISPLAY_URL__: string | undefined;
declare const __PATCHPILOT_ADMIN_API_REQUEST_MODE__: "direct" | "proxy" | undefined;
