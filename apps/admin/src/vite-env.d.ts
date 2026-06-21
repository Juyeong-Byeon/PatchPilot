/// <reference types="vite/client" />

// Type the app's own env vars so reads are `string | undefined` instead of `any`
// (Vite's ImportMetaEnv has a `[key: string]: any` index signature).
interface ImportMetaEnv {
  readonly VITE_ADMIN_API_BASE_URL?: string;
}
