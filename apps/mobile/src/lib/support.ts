/**
 * Support contact — mirrors web's CONTACT_EMAIL/CONTACT_PHONE (apps/web
 * lib/features.ts). Reads EXPO_PUBLIC_CONTACT_* at build time with the same
 * defaults so the plan-upgrade / contact-us channel is identical across apps.
 */
export const CONTACT_EMAIL = process.env.EXPO_PUBLIC_CONTACT_EMAIL ?? 'hello@sahancafe.app';
export const CONTACT_PHONE = process.env.EXPO_PUBLIC_CONTACT_PHONE ?? '';

export type SupportContact = { name: string; email: string; phone?: string };

// The support team shown in the "Contact us" screen. Saroj reuses the
// deployment-configured contact; the others are fixed team members.
export const SUPPORT_CONTACTS: SupportContact[] = [
  { name: 'Saroj', email: CONTACT_EMAIL, phone: CONTACT_PHONE || undefined },
  { name: 'Sudip', email: 'sudip.kunwar9898@gmail.com', phone: '9843413772' },
  { name: 'Asmin', email: 'shrestha.asmin17@gmail.com', phone: '9860099303' },
];

/** mailto: link for a general contact-us message. */
export function contactMailto(email = CONTACT_EMAIL, subject = 'GoServe — support'): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/** tel: link for a phone number (strips spaces). */
export function contactTel(phone: string): string {
  return `tel:${phone.replace(/\s+/g, '')}`;
}
