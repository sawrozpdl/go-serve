// =========================================================================
// The guest play page's data layer.
//
// Deliberately standalone — plain fetch, no TanStack Query, no auth store, no
// shared api client. This file must never import from '@/lib/api' or
// '@/lib/public': both would drag the admin entry graph into a bundle whose
// entire justification is not having it. eslint enforces that for src/play/**.
//
// Query's cache, persistence and retry machinery buys nothing on a page a guest
// opens once for fifteen seconds, and costs ~13KB gzipped.
// =========================================================================

// VITE_API_BASE_URL, not VITE_API_URL: the former is the origin baked into the
// bundle (empty in dev so paths stay relative and the Vite proxy forwards
// them), the latter is only the dev proxy's TARGET and never reaches the
// client. Same variable lib/api.ts and lib/public.ts use.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class PlayApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/public/play/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // A café's wifi dropping is the single most likely failure here, and it
    // deserves a sentence a guest understands rather than a stack trace.
    throw new PlayApiError(0, 'offline', "Couldn't reach the café — check your connection.");
  }
  if (!res.ok) {
    let code = 'error';
    let message = 'Something went wrong.';
    try {
      const j = (await res.json()) as { code?: string; message?: string };
      code = j.code ?? code;
      message = j.message ?? message;
    } catch {
      /* a non-JSON error body (a proxy page, say) keeps the defaults */
    }
    throw new PlayApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

// =========================================================================
// Wire types — mirrors of the Go DTOs in engage_play.go.
//
// Note what ISN'T here: reward values, menu item ids, budget figures. The
// server never sends them, because this JSON is readable by anyone holding the
// phone and would otherwise be a guide to farming the campaign.
// =========================================================================

export type PlayGame = 'tea_runner' | 'memory_match' | 'stack';
export type PlayDifficulty = 'gentle' | 'normal' | 'tricky';

export type PlayCafe = {
  name: string;
  slug: string;
  logo_url?: string;
  accent_emoji?: string;
  branding: Record<string, unknown>;
};

export type PlayTier = { min_score: number; label: string };

export type PlayCampaign = {
  game: PlayGame;
  difficulty: PlayDifficulty;
  headline: string;
  subhead: string;
  terms_text: string;
  reward_ttl_seconds: number;
  contact_capture_enabled: boolean;
  allow_claim_without_play: boolean;
};

export type PlayCode = {
  code: string;
  label: string;
  expires_at: string;
  seconds_left: number;
};

export type PlayBootstrap = {
  cafe: PlayCafe;
  campaign: PlayCampaign | null;
  tiers: PlayTier[];
  can_win_today: boolean;
  practice_reason?: string;
  todays_code?: PlayCode | null;
};

export type PlaySession = {
  session_token: string;
  seed: number;
  game: PlayGame;
  difficulty: PlayDifficulty;
  winnable: boolean;
  resumed?: boolean;
};

export type PlayScoreResult = {
  outcome: 'win' | 'no_reward' | 'practice';
  score?: number;
  code: PlayCode | null;
  replayed?: boolean;
};

export function bootstrapPlay(slug: string, fingerprint: string) {
  return post<PlayBootstrap>(`${encodeURIComponent(slug)}/bootstrap`, { fingerprint });
}

export function startPlaySession(slug: string, fingerprint: string) {
  return post<PlaySession>(`${encodeURIComponent(slug)}/sessions`, { fingerprint });
}

export function submitPlayScore(
  slug: string,
  sessionToken: string,
  score: number,
  elapsedMs: number,
  events: number,
) {
  return post<PlayScoreResult>(`${encodeURIComponent(slug)}/sessions/score`, {
    session_token: sessionToken,
    score,
    elapsed_ms: elapsedMs,
    events,
  });
}

export function submitPlayContact(
  slug: string,
  sessionToken: string,
  input: { name?: string; email?: string; phone?: string; consentTextVersion: string },
) {
  return post<{ saved: boolean }>(`${encodeURIComponent(slug)}/sessions/contact`, {
    session_token: sessionToken,
    name: input.name ?? '',
    email: input.email ?? '',
    phone: input.phone ?? '',
    consent: true,
    consent_text_version: input.consentTextVersion,
  });
}

/** The slug from /play/{slug}. One URL shape, so a router would be 11KB of
 *  gzipped machinery to replace one regex. */
export function slugFromLocation(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.match(/^\/play\/([^/?#]+)/)?.[1] ?? '');
}
