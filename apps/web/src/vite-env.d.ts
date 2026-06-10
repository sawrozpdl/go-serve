/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

declare module '@cafe-mgmt/design-tokens/tokens.css';

interface ImportMetaEnv {
  /**
   * Absolute base URL of the API for production builds, e.g.
   * "https://api.cafe.example.com". Empty in dev, where the Vite proxy
   * forwards relative `/v1`, `/auth`, and `/ws` paths to VITE_API_URL.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** SemVer string of the running web bundle, sourced from apps/web/package.json
 *  at build time. Bump on user-visible changes per SemVer (major/minor/patch). */
declare const __APP_VERSION__: string;
/** Short git SHA of the commit the bundle was built from. Empty when the
 *  build wasn't run inside a git checkout. */
declare const __APP_GIT_SHA__: string;
/** ISO timestamp of the build. */
declare const __APP_BUILD_TIME__: string;
