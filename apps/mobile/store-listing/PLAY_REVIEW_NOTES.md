# Play Console — what to fill in for v1.1.3

Two rejections came from reviewers being unable to sign in. v1.1.3 makes sign-in
unnecessary for review: the login screen carries an **Explore as a guest** control
that runs the whole app against sample data on the device, with no account and no
network. Everything below is Play Console text — no build change.

## App content → App access

Choose **"All or some functionality is restricted"**, then add one instruction:

- **Name:** Guest demo (no credentials needed)
- **Any other instructions:**

  > Tap "Explore as a guest" on the first screen. The app opens a sample café
  > with its own data and every feature is reachable without an account: take an
  > order from the Floor tab, send it to the kitchen, advance the tickets on the
  > Kitchen tab, then settle and close the tab. History and Dashboard update as
  > you go. A "Demo mode - sample data" strip stays at the top of the screen, and
  > "Exit demo" in the More tab returns to sign-in.
  >
  > Signing in is invite-only and is not required to review the app. Creating a
  > Google account through the sign-in button leads to an "Access needed" screen,
  > because a new account is not yet attached to a café - that screen also offers
  > the guest demo.

Leave the username/password fields empty — there is nothing to log in to.

## Release notes (What's new)

> You can now explore Go Serve without an account — tap "Explore as a guest" to
> try a sample café. Signing in also explains itself better when your account
> isn't attached to a café yet.

## Screenshots

The existing sets predate guest mode. Recapture from the demo café so what a
reviewer sees matches the listing: Floor (five tabs, each in a different state),
Kitchen (tickets across Kitchen/Bar), the Settle sheet, and Dashboard.

Capture on a device build, NOT the dev client — the dev client draws a floating
gear bubble over the top-right corner that will appear in every shot.

## Still required outside Play Console

Register the **App Signing** SHA-1 as an Android OAuth client for
`com.goserve.app` in Google Cloud:

    5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25

Play Console → Test and release → Setup → App signing → *App signing key
certificate*. The **upload** key (`10:E8:31:89:58:71:1C:9C:…`) is already
registered, which is why sign-in works on a locally-installed build and fails on
anything installed from Play. Guest mode means this no longer blocks approval, but
until it is done every real Play user lands on the "Access needed" screen.

## Release blocker: wire mail for goserve.com.np

The "Access needed" screen shows `hello@goserve.com.np`, and that screen is the
ONLY surface a locked-out real user can reach — they cannot get into the app to
find Contact us. As of 2026-08-19 the domain has **no DNS at all**:

    goserve.com.np       A: -   MX: -   NS: -
    sahancafe.app        A: -   MX: -   NS: -    (the previous fallback, also dead)
    sarojpaudyal.com.np  A: yes MX: mx1/mx2.improvmx.com

So mail to that address bounces until you add MX records. Reviewers are unaffected
(they use the guest demo), but real customers turned away at sign-in have no way to
reach you until this is done.

Interim fix without a rebuild: set `EXPO_PUBLIC_CONTACT_EMAIL` in the EAS
production environment to an address on `sarojpaudyal.com.np`, which already
forwards via ImprovMX. The code default takes over again once you clear the var.
