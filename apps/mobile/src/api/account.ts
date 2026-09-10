/**
 * The user's own account, across every workspace — export and deletion.
 *
 * Both Apple (5.1.1(v)) and Google Play REQUIRE an app that lets people create
 * an account to let them delete it from inside the app. Go Serve had neither
 * on mobile, which is a store-review rejection waiting to happen as much as it
 * is a thing people are owed.
 *
 * These are identity-scoped, not workspace-scoped: they act on the signed-in
 * user everywhere they are a member, so neither takes a tenant slug.
 */
import { useMutation } from '@tanstack/react-query';
import { api } from './client';

/** The 409 the server answers when deleting would orphan a workspace. */
export type SoleOwnerRefusal = {
  code: 'sole_owner';
  message: string;
  /** Slugs of the workspaces where this user is the only active owner. */
  workspaces: string[];
};

export function isSoleOwnerRefusal(e: unknown): e is SoleOwnerRefusal {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'sole_owner';
}

/** Everything the platform holds about this user, as one JSON document. */
export function useExportMyData() {
  return useMutation({ mutationFn: () => api.get<Record<string, unknown>>('/v1/me/export') });
}

/**
 * Delete the account. Irreversible.
 *
 * The server refuses with 409 `sole_owner` when the user is the last owner of
 * any workspace — deleting them would leave a cafe nobody can administer. The
 * caller is expected to name those workspaces rather than showing a bare
 * error, which is why the refusal type is exported above.
 */
export function useDeleteMyAccount() {
  return useMutation({ mutationFn: () => api.del('/v1/me') });
}
