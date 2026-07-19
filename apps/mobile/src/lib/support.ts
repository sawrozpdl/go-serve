/**
 * Support contact — mirrors web's CONTACT_EMAIL/CONTACT_PHONE (apps/web
 * lib/features.ts). Reads EXPO_PUBLIC_CONTACT_* at build time with the same
 * defaults so the plan-upgrade / contact-us channel is identical across apps.
 */
export const CONTACT_EMAIL = process.env.EXPO_PUBLIC_CONTACT_EMAIL ?? 'hello@sahancafe.app';
export const CONTACT_PHONE = process.env.EXPO_PUBLIC_CONTACT_PHONE ?? '';

/** mailto: link for a general contact-us message. */
export function contactMailto(subject = 'GoServe — support'): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/** tel: link, or null when no support phone is configured. */
export function contactTel(): string | null {
  return CONTACT_PHONE ? `tel:${CONTACT_PHONE.replace(/\s+/g, '')}` : null;
}
