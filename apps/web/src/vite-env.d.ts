/// <reference types="vite/client" />

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
