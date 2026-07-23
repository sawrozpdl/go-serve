/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Origin of the live app, e.g. https://app.goserve.com.np — login + CTA target. */
  readonly PUBLIC_APP_URL?: string;
  /** API origin the public contact form posts to, e.g. https://api.goserve.com.np. */
  readonly PUBLIC_API_URL?: string;
  /** Primary contact email surfaced in the footer + contact page. */
  readonly PUBLIC_CONTACT_EMAIL?: string;
  /** Optional primary contact phone. */
  readonly PUBLIC_CONTACT_PHONE?: string;
}
