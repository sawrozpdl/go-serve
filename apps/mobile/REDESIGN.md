# GoServe Mobile Redesign — "Docket" Handover (Phases 2–5)

> Audience: the agent executing the remaining redesign phases. Phases 0–1 are
> DONE and committed (`git log --oneline -1` ≈ "Mobile redesign Phase 0+1").
> This doc is the source of truth for what to build and — just as important —
> what NOT to do. The approved plan lives at
> `~/.claude/plans/i-had-opus-write-sunny-pancake.md`; this doc supersedes it
> where more specific. The user-approved visual mockup:
> https://claude.ai/code/artifact/67583974-03b4-4498-a158-c937440acc35

---

## 0. Mission and status

The app (Expo SDK 57, RN 0.86, React 19, expo-router + reactCompiler) is
functionally complete but visually flat. We are executing a redesign called
**Docket — paper & ink**: *the screen and the printout share one language*.
This app literally prints thermal kitchen dockets and receipts; on screen,
orders/tickets/receipts look like their printed selves.

**Done (committed):**
- Phase 0: token seam `packages/design-tokens/src/scales.v2.ts` (+ `/v2`
  subpath export, additive `tokens.css` block), `buildTheme` v2 fields
  (`surfaces`, `stamp`, `typeStyles`, `focus`, `skeleton`, `touch`),
  `src/theme/motion.ts`, `src/lib/layout.ts`, JetBrains Mono loaded
  (`fonts.ts`: `mono/monoMedium/monoBold`).
- Phase 1: primitives in `src/components/ui/` (full list §4), `AppSheet` on
  @gorhom/bottom-sheet, custom `TabBar` component (not yet wired), dev
  gallery at `src/app/(app)/more/gallery.tsx`, jest infra for
  reanimated/gorhom (§9).
- **Values are still v1** — `scales.v2.ts` currently ALIASES the old palette
  so nothing shifted visually. Dropping the Docket values (§3) is the first
  act of Phase 2.

**Remaining:** Phase 2 (value drop + login/OTP + floor + tab bar → user
review), Phase 3 (order detail + menu + settle), Phase 4 (KDS + dashboard),
Phase 5 (cleanup + guardrails + brand assets).

**Gate:** the user must confirm the dev gallery (`/more/gallery` in the dev
client) works on iOS + physical Android + tablet — specifically (a) the
gorhom sheet opens/drags/dismisses and the keyboard pushes the amount field
up on Android, and (b) the selected Card shows no rectangular shadow artifact
on Android. If gorhom is broken on this version triple, fall back per §8.3.

---

## 1. Design language — the thinking

**Concept.** A cafe POS's most honest artifact is the docket: monospaced,
high-contrast, instantly scannable, beautiful in a workmanlike way. We make
the UI speak that language instead of generic SaaS. Floor staff work in
bright daylight → the floor runs on **warm paper** (light-first). The kitchen
is glanced at from meters away → the KDS is a **carbon board with paper
ticket cards pinned to it** (the one place we force dark). Amber `#FFA319`
survives from the old brand but is **demoted from "wash everything" to "mark
what matters"** — a stamp/highlighter color for selection, status, live
counts, and CTAs only.

**Three type voices, strict roles:**
- **JetBrains Mono** — every price, qty (`2×`), timer, table number
  (`T1 · WINDOW`), stamp, section eyebrow, docket meta. Always
  `fontVariant: ['tabular-nums']` (the `MonoText` primitive does this).
- **Inter** — all working UI copy (buttons, labels, item names, hints).
- **Fraunces italic** — brand moments ONLY: login wordmark, empty-state
  headlines, sheet titles via `Heading`. If Fraunces appears more than ~once
  per screen, it's being overused.

**The boldness budget** (everything else stays quiet — this is the核心 rule):
1. **Stamps** `[ SENT ] [ READY ] [ PAID ]` — `ui/Stamp`, uppercase mono,
   1.5px border, tinted wash; punches in (scale + haptic) when a status lands.
2. **Dotted leaders** — `2× Cappuccino ·········· 480` on every ticket line
   and totals row (`ui/DottedLeader`).
3. **Perforation** — the tear line between docket items and totals
   (`ui/Perforation`; parent card needs `overflow: 'hidden'`).
4. **Big mono money** — totals/KPIs in `MonoText size="display" weight="bold"`.
   The number is the hero; its label is a tiny mono eyebrow.
5. **The send moment** — the ONE orchestrated animation (§6.5).

**Motion restraint.** Only these animate: press feedback (`PressableScale`),
sheet physics (gorhom, free), list item enter/exit (`enterUp`/`exitFade`/
`listLayout`), skeleton shimmer, tab-bar active pill, stamp punch-in, the
login entrance, the send moment. Nothing else. Every preset already carries
`ReduceMotion.System`. Never call `FadeIn.duration()` etc. inline — extend
`src/theme/motion.ts` if a new preset is genuinely needed (and add the name
to the reanimated jest mock's builder exports, §9.1).

**Copy voice.** Plain verbs, sentence case ("Send 3", "Close tab", "Tap to
clear"). Errors say what happened and how to recover, never apologize.
Empty states invite action ("This tab is empty — tap Add items"). An action
keeps its name through the flow (button "Send" → toast "Sent").
Money renders through `formatNPR(cents)` from `src/lib/format.ts` — do NOT
invent new formatters, and do NOT change "Rs" to "₨" (existing tests assert
"Rs" strings; the mockup's ₨ glyph is aspirational, not a requirement).

**Layout rhythm.** Screen padding `spacing[5]` (20). Gap between sections
`spacing[6]` (24). Cards use `radii.lg` (16), sheets `radii['2xl']` (28).
Section headers are `ui/Section` (mono eyebrow + dotted leader), never
ad-hoc `<AppText variant="label">`.

---

## 2. Hard rules (violating any of these is a review-blocker)

1. **Presentation layer only.** Never modify: `src/api/*`, `src/offline/*`,
   `src/auth/*` + `can()` call sites, `src/printing/*`, `src/realtime/*`,
   `src/stores/*`, `src/kitchen/board.ts`, `src/finance/calc.ts`,
   `apps/api`, `apps/web`, `apps/landing`. Handlers move verbatim, never
   rewritten (§6.1).
2. **No literal styling values in screens**: no numeric `fontSize:` outside
   `ui/` (use `theme.text` / `theme.typeStyles` / `MonoText size=`), no
   `width: '48%'` (use `ui/Grid` + `useLayout().columns`), no
   `hexToRgba(color, 0.16)` chips (use `Stamp`/`theme.colors.stamp`), no `›`
   glyphs (Lucide `ChevronRight` via `ListRow`), no new `Ionicons` usage.
3. **Android elevation invariant**: any tinted background on an elevated
   surface must be an OPAQUE hex (`mixHex`, `theme.colors.primaryTint`,
   `theme.colors.stamp[tone].bg` — all already opaque). Never put an rgba
   background or a gradient on a View that carries `elevation`.
4. **Touch targets ≥ `theme.touch.min` (44dp)** for every new pressable.
5. **Keep accessibility labels and user-visible copy STABLE** unless the
   redesign intentionally changes them — tests select by label/text
   (`table-T1`, `new-walkin`, `email`, `sheet-close`…). When copy must
   change, update the test in the same commit.
6. **Behavioral invariants** (verify each survives your changes):
   empty new tab auto-opens the menu; add/remove symmetry incl. the
   `stackItems` pref; offline "reconnect to start a tab" nudge; settle fully
   blocked offline; receipt prints from the PRE-close snapshot; permission
   gating on tabs/actions; KDS haptic on genuinely-new tickets only.
7. **Commit per phase** with tests green. Do NOT `git push` (user pushes).
8. Inputs inside any `AppSheet` must be `AppSheet.TextInput` (or
   `AmountInput insideSheet`) and scrollable sheet content must be
   `AppSheet.ScrollView` — otherwise keyboard avoidance silently breaks.

---

## 3. Phase 2, step 1 — drop the Docket values into `scales.v2.ts`

This is the entire palette swap. Edit ONLY
`packages/design-tokens/src/scales.v2.ts` (and the `tokens.css` v2 comment
block if you add static values). Replace the alias lines with real maps.
The keys/roles are fixed; these are the values:

```ts
/** Carbon — warm near-black (replaces the cool purple-black v1 dark). */
export const INK_SCALE_DARK_V2: InkScale = {
  1000: '#0f0e0b', // page bg — the carbon board
  900: '#171511',  // panels
  850: '#1a1813',
  800: '#1d1b16',  // cards
  700: '#2a2721',  // hairline / divider
  600: '#37332a',  // hover surfaces
  500: '#4a4438',  // heavy borders
  400: '#6b6455',  // muted icons
  300: '#8c857a',  // tertiary text
  200: '#c4beb2',  // secondary text
  100: '#f2eee6',  // primary text
  50: '#fbf8f1',   // hi-contrast / display
};

/** Paper — warm daylight. NOTE the deliberate monotonicity break: 800 (card)
 * is LIGHTER than 1000 (page) — a white docket popping on tinted paper. This
 * is intentional and safe: buildTheme maps roles (card/bg/border), and
 * primaryTint/stamp bgs mix against ink[800] so they come out warm cream. */
export const INK_SCALE_LIGHT_V2: InkScale = {
  1000: '#f6f3eb', // page bg — steamed-milk paper
  900: '#efebe0',  // panels
  850: '#e8e3d4',
  800: '#fffdf8',  // cards — white paper, lighter than page ON PURPOSE
  700: '#e3ddcf',  // hairline / divider
  600: '#d6cfbc',  // hover surfaces
  500: '#b3aa92',  // heavy borders
  400: '#857d6b',  // muted icons
  300: '#6e675c',  // tertiary text
  200: '#3e382e',  // secondary text
  100: '#16130e',  // primary text — warm espresso ink
  50: '#0a0805',
};

/** Status — re-tuned warm. Same keys as STATUS_DARK/LIGHT. */
export const STATUS_DARK_V2: StatusColors = {
  amberFg: '#ffa319',
  limeFg: '#a3f02c',
  dangerFg: '#ff6b5e',
  dangerBg: 'rgba(255, 107, 94, 0.10)',
  dangerBorder: 'rgba(255, 107, 94, 0.30)',
  infoFg: '#b8d2ff',
  infoFgStrong: '#8fb6e8',
  infoBg: 'rgba(143, 182, 232, 0.08)',
  infoBorder: 'rgba(143, 182, 232, 0.25)',
  successFg: '#67c15e',
  warnFgTile: '#f0b85a',
  okBg: 'rgba(103, 193, 94, 0.10)',
  okBorder: 'rgba(103, 193, 94, 0.30)',
  warnBg: 'rgba(255, 163, 25, 0.10)',
  warnBorder: 'rgba(255, 163, 25, 0.30)',
};

export const STATUS_LIGHT_V2: StatusColors = {
  amberFg: '#b86f00',
  limeFg: '#3f6310',
  dangerFg: '#c23b2e',
  dangerBg: 'rgba(194, 59, 46, 0.08)',
  dangerBorder: 'rgba(194, 59, 46, 0.30)',
  infoFg: '#3b5f8a',
  infoFgStrong: '#2e4e77',
  infoBg: 'rgba(59, 95, 138, 0.08)',
  infoBorder: 'rgba(59, 95, 138, 0.25)',
  successFg: '#3e7a34',
  warnFgTile: '#8a5500',
  okBg: 'rgba(62, 122, 52, 0.10)',
  okBorder: 'rgba(62, 122, 52, 0.35)',
  warnBg: 'rgba(184, 111, 0, 0.12)',
  warnBorder: 'rgba(184, 111, 0, 0.35)',
};
```

Also in this step:
- `TEXT_SCALE_V2`: bump `md: 13 → 14`, `lg: 15 → 16` (the spread of
  `TEXT_SCALE` keeps old values — override them explicitly now). Update
  `TYPE_STYLES.md` to `{ size: 14, lineHeight: 20, tracking: 0 }` and
  `TYPE_STYLES.lg` to `{ size: 16, lineHeight: 22, tracking: 0 }`.
- `STAMP_TONE_FG_*` reference `INK_..._V2[300]` and `STATUS_..._V2` — they
  update automatically; verify the derived stamps in the gallery.
- `MOODS_V2`: leave aliased to `MOODS` (per-mood tuning is post-v1 polish).
- `buildTheme.resolveTypography`: set `numFamily: FONT_FAMILY.monoMedium`
  in **all three** presets (editorial/modern/minimal) — numerals are mono in
  every tenant personality.
- Fix the `buildTheme.test.ts` expectations that assert v1 parity: the test
  `'exposes the extended v2 type ramp'` asserts `t.text.lg === 15` → 16, and
  the ink-scale tests compare against `INK_SCALE_DARK` → compare against
  `INK_SCALE_DARK_V2` (import from the package root). Keep the 100% gate.
- Sanity: `pnpm --dir apps/web typecheck` must still pass and web must be
  visually untouched (it never imports `/v2` values).

**Contrast floor:** primary text on page ≥ 12:1 both schemes (these values
clear it); mono meta (`300` ink) is decorative-adjacent, never for critical
copy. `stamp.brand.fg` on light auto-darkens via `mixHex(primary,'#000',0.72)`
in buildTheme — do not bypass it.

---

## 4. Primitive cheat sheet (all in `src/components/ui/`, all themed, all tested)

| Primitive | Use for | Key props |
|---|---|---|
| `Card` | any elevated paper surface | `level 2\|3, selected, elevated, padded, onPress` |
| `Stamp` | ALL status chips | `label, tone: neutral\|info\|warn\|success\|danger\|brand, size sm\|md, dot` |
| `Chip` | selectable filters/tenders | `label, selected, onPress, icon, count` |
| `ListRow` | settings/detail rows | `title, subtitle, left, value (mono), right, chevron, destructive, onPress` |
| `Section` | titled blocks | `title, count, action` → mono eyebrow + dotted leader |
| `Stat` | KPI tiles | `label, value, size md\|lg, tone, hint, loading` |
| `EmptyState` | empty lists/boards | `icon, title (Fraunces), hint, action` |
| `ErrorState` | FAILED fetches (not empty!) | `title?, detail?, onRetry` |
| `Skeleton` / `Skeleton.Card` | loading | `width, height, radius` / `lines` |
| `Stepper` | ALL qty steppers | `value, onIncrement, onDecrement, min, max, size md(44)\|lg, label` |
| `AmountInput` | money entry | `valueCents, onChangeCents, quickAmounts, insideSheet, error` |
| `AppSheet` | ALL bottom sheets | `open, onClose, title, full, rightAction, footer` + `.ScrollView/.TextInput` |
| `TabBar` | the tabs bar | receives BottomTabBarProps (structural subset type) |
| `PressableScale` | custom pressables | `pressedScale, haptic, style` |
| `Grid` | tile grids | `columns` (from `useLayout().columns(target, min, max)`) |
| `DottedLeader` | label ····· value | `color?, height?` (flex:1 spacer) |
| `Perforation` | docket tear line | parent needs `overflow: 'hidden'` |
| `MonoText` (in `Text.tsx`) | every number | `size (ramp key), weight regular\|medium\|bold, muted` |
| `Heading` | Fraunces moments | `size (ramp key)` — pass size to get paired lineHeight |

Standard screen state machine (use everywhere):

```tsx
{query.isLoading ? (
  <Skeleton.Card lines={2} />            // or a grid of them matching layout
) : query.isError ? (
  <ErrorState detail={String(query.error)} onRetry={() => query.refetch()} />
) : items.length === 0 ? (
  <EmptyState icon={<X size={28} color={theme.colors.textMuted} />} title="…" hint="…" />
) : (
  …content…
)}
```

Docket ticket-line idiom (the signature look — reuse verbatim):

```tsx
<View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
  <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>2×</MonoText>
  <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>Cappuccino</AppText>
  <DottedLeader />
  <MonoText>{formatNPR(cents)}</MonoText>
</View>
```

---

## 5. Phase 2 — vertical slice (login/OTP + tab bar + floor) → USER REVIEW STOP

### 5.1 Tab bar wiring — `src/app/(app)/_layout.tsx`
Replace the Ionicons `icon()` helper + default bar with the custom TabBar and
Lucide icons. Keep the permission gating exactly as-is (`href: null` hides —
the TabBar filters those). Sketch:

```tsx
import { LayoutGrid, ChefHat, Clock3, MoreHorizontal } from 'lucide-react-native';
import { TabBar, type TabBarProps } from '@/components/ui/TabBar';

<Tabs
  tabBar={(props) => <TabBar {...(props as unknown as TabBarProps)} />}
  screenOptions={{ headerShown: false }}
>
  <Tabs.Screen name="floor" options={{
    title: 'Floor', href: canFloor ? undefined : null,
    tabBarIcon: ({ color, size }) => <LayoutGrid size={size} color={color} strokeWidth={2.2} />,
  }} />
  … kitchen: ChefHat · history: Clock3 · more: MoreHorizontal …
</Tabs>
```
Focused/unfocused is conveyed by the pill + color (TabBar handles it), so a
single Lucide icon per tab is enough — delete the filled/outline pair logic.
`more.test.tsx` renders the More screen directly and should be unaffected;
if any test rendered the layout, update its expectations.

### 5.2 Login + OTP — `src/app/(auth)/login.tsx`, `otp.tsx`
Login is already the best screen; refine, don't rebuild:
- Wordmark: keep Fraunces italic but move to the ramp —
  `Heading size="displayLg"` (44) instead of the hardcoded 52; add a small
  mono eyebrow above it: `GOSERVE · POINT OF SALE` (mono, 2xs, letterSpacing
  1.6, `stamp.brand.fg`).
- Entrance (one-time): wordmark `entering={enterUpDelayed(0)}`, tagline
  `enterUpDelayed(1)`, form card `enterUpDelayed(2)` (from `theme/motion`).
- The ☕ emoji chip: replace with the `Stamp` idiom? NO — keep it, it's
  charming; just ensure it sits on a `Card level={2}`.
- OTP error shake: on failed verify, a small `withSequence` translateX
  (±6px, 3 cycles, `dur.fast`) on the code field — put the hook in
  `motion.ts` as `useShake()` and add any new builders to the jest mock.
- Keyboard handling here is already correct — do not change the
  `automaticallyAdjustKeyboardInsets` setup.
- Keep a11y labels `email`, the dev-login/google buttons' labels, and
  `authFlow.test.tsx` selectors stable.

### 5.3 Floor — `src/app/(app)/floor/index.tsx` (rebuild on primitives)
Target structure (phone; tablet only differs by grid columns):

```
┌ SAHAN CAFE (mono eyebrow, brand fg)      [● LIVE] ┐   ← Stamp success dot,
│ Floor (Inter semibold, typeStyles 3xl/4xl)        │     driven by ws/connectivity
│ [＋ New walk-in tab]  ← Button primary, full width │
│ WALK-INS · 2 ····························          │   ← Section w/ count
│  Card: name / meta        Rs 640  [FIRING]        │   ← TabCard on Card+Stamp
│ TABLES · 8 ·······························         │
│  Grid(columns): TableTile cards                   │
└ TabBar ───────────────────────────────────────────┘
```
- Extract `TabCard` and `TableTile` into `src/components/order/` (new dir),
  built on `Card`/`Stamp`/`MonoText`. Keep their a11y labels EXACTLY:
  `table-T1` etc., `new-walkin` (check the current file for the exact
  strings before renaming anything).
- TableTile states: **occupied** = `Card` + 3px amber left edge (absolute
  View, `borderRadius` 0-3-3-0, INSIDE the card so elevation stays safe) +
  live amount `MonoText weight="bold"` + `Stamp` (tone by state: firing →
  brand, ready → success); **free** = `Card elevated={false}` quiet, mono
  `T3` muted; **dirty** = `Card elevated={false}` with `borderStyle:
  'dashed'` + `Stamp label="Dirty"` + hint "Tap to clear" (keep the existing
  press-to-clear behavior; the 0.5-opacity treatment dies — dashed border
  reads "needs attention" without killing legibility).
- Grid: `useLayout().columns(170, 2, 6)` for tables. Walk-ins stay
  full-width rows.
- States: initial load → a `Grid` of `Skeleton.Card`; fetch error →
  `ErrorState onRetry={refetch}`; keep `RefreshControl`.
- List motion: new/removed tiles `entering={enterUp}` `exiting={exitFade}` +
  `layout={listLayout}` (wrap tiles in `Animated.View`; if the React
  Compiler complains, isolate in a small `AnimatedTile` component).
- The sticky "New walk-in tab" header behavior stays as today (pinned above
  the scroll).

### 5.4 Phase 2 verification + STOP
`pnpm --dir apps/mobile typecheck && pnpm --dir apps/mobile lint &&
pnpm --dir apps/mobile exec jest --silent --coverage` all green;
`floor.test.tsx` + `authFlow.test.tsx` updated in the same commit if copy
moved. Then **STOP and ask the user to review on device** (both schemes ×
phone + tablet, reduced-motion on, 2–3 moods via the gallery). Do not start
Phase 3 without an explicit go.

---

## 6. Phase 3 — order detail + menu + settle (the money path)

### 6.1 Extraction discipline for `floor/[orderId].tsx` (825 lines)
**Move, don't rewrite.** Three new files in `src/components/order/`:
- `useOrderController.ts` — ALL hooks/handlers verbatim: `ensureOrderId`
  (the `ensureRef` promise-dedupe MUST survive), `addMenuItem`/
  `removeMenuItem` (incl. `stackItems` pref logic), `doSend` (incl. KOT
  print sequencing), `doReprint`, rename, offline nudges, `confirmSend`
  state. Return one object consumed by both compositions.
- `TicketPanel.tsx` — presentational: header block, lines list, totals,
  action bar. Props: `{ order, lines, pendingCount, callbacks…, capability
  flags }`. No data fetching inside.
- `MenuGrid.tsx` — category chips (`Chip`, keep the >6-categories two-row
  collapse behavior) + item grid (`Grid` + `useLayout().columns(160, 2, 5)`)
  + `MenuItemCard` (on `Card selected=`, count badge = `Stamp size="sm"
  tone="brand"`, on-card stepper = `ui/Stepper size="md"` — this kills the
  26px stepper; keep the nested-Pressable event-capture trick from the
  current `QtyStepper` so card-tap ≠ stepper-tap).

Route file becomes a composer:

```tsx
const ctrl = useOrderController(orderId);
const { splitView } = useLayout();
return splitView ? (
  <Row>
    <MenuGrid …ctrl */ style={{ flex: 3 }} />
    <Hairline vertical />
    <TicketPanel …ctrl style={{ flex: 2, minWidth: 360 }} />
  </Row>
) : (
  <>
    <TicketPanel …ctrl fullScreen />
    <AppSheet open={ctrl.menuOpen} full …><MenuGrid …ctrl /></AppSheet>
  </>
);
```
Phone keeps today's exact behavior (menu auto-opens for a brand-new draft —
`useState(() => isDraft)` logic moves into the controller untouched).

### 6.2 TicketPanel — the docket design
The ticket is the hero. One `Card` with `overflow: 'hidden'`:
- `docket-head`: mono 2xs uppercase row — left `DOCKET · {tableLabel}`,
  right the order's opened time. Hairline below.
- Lines: the §4 ticket-line idiom + per-line: note in amber italic Inter sm
  (`stamp.brand.fg`, `fontStyle: 'italic'`) indented under the name;
  status as `Stamp size="sm"` (`Sent` brand / nothing for pending); qty
  editing via `Stepper size="md"` revealed on line tap (keep current
  interaction if it differs — check the file first).
- `Perforation` between lines and totals.
- Totals: `SUBTOTAL` mono sm muted rows, then the grand total —
  `TOTAL` eyebrow left, `MonoText size="display" weight="bold"` right.
- Action bar (pinned bottom, safe-area): ghost `＋ Add items` + primary
  `Send {n}` (+ `Settle` when nothing pending — mirror current logic).

### 6.3 Send behavior change (UX defect #4) — the ONE behavior change
Today a confirm sheet interrupts EVERY fire. New behavior:
- Default: **direct send** — tap `Send 3` → `doSend()` immediately + success
  haptic + toast "Sent 3 to kitchen".
- **Long-press** on Send opens the recap sheet (the existing confirm sheet
  content, restyled as a mini docket) with a "Confirm — send 3" button.
- **Honor the tenant pref**: search the prefs the app already fetches
  (`useMe`/tenant preferences — grep `preferences` in `src/api`) for the
  pre-send-confirm flag from web's 0012 prefs. If the tenant explicitly
  enabled it, keep the sheet on every tap. If absent → direct send.
- A hint line under the ticket: "3 new items ready to fire · hold Send to
  review" (mono/muted, sm).
- `send.mutateAsync` and KOT printing sequence are UNTOUCHED.

### 6.4 SettleSheet rebuild — `src/components/settle/SettleSheet.tsx`
Shell: old `Sheet` → `AppSheet` (`open/onClose` props identical). Content
(handlers `doRecord`, `onCloseTab`, snapshot-before-close, offline gating
move VERBATIM — only the render tree changes):
- Totals block = receipt-style card (`MonoText` rows + dotted leaders +
  grand "Rs X" `display`), replacing the plain rows.
- Payments taken = `ListRow` list (`value` = amount, `right` = reclassify/
  delete affordances as today).
- Discount toggle = two `Chip`s (Rs / %) + `AmountInput insideSheet`.
- Amount = `AmountInput insideSheet autoFocus quickAmounts={[balance]}`
  (label the chip "Full balance" via `formatAmount`).
- Tenders = three `Card onPress selected=` tiles (Cash/Online/House tab),
  icon + label, min 56dp tall.
- Close CTA keeps its state-dependent label logic exactly ("Collect Rs X to
  close" / "Close tab" / "Remove a payment to close").
- Offline: keep the red notice + disabled inputs (`Stamp tone="danger"
  label="Offline"` + AppText explanation).
- `settle.test.tsx` selectors: check before renaming anything.

### 6.5 The send moment (signature animation)
On successful send: (1) each just-sent line's `Stamp` mounts with a punch —
add to `motion.ts`: `stampPunch = ZoomIn.duration(dur.fast).easing(ease.spring)
.reduceMotion(ReduceMotion.System)` (add `ZoomIn` to the jest-mock builder
list!), used as `entering` on the Stamp's wrapper; (2) one
`Haptics.notificationAsync(Success)`; (3) toast "Sent N to kitchen". That's
the whole moment — no full-screen theatrics.

### 6.6 Verification
Jest suites: `settle.test.tsx`, orders/offline hook tests (should be
untouched — they're under `src/api`), floor tests. On device: keyboard over
the amount field on a small Android phone; tablet landscape split view
add → send → settle end-to-end; offline invariants (§2.6); long-press recap;
receipt still prints from snapshot. Commit.

---

## 7. Phase 4 — KDS + dashboard

### 7.1 Forced-dark KDS (paper dockets on the carbon board)
The kitchen screen ALWAYS renders carbon, regardless of user scheme. Add a
scope wrapper to `src/theme/ThemeProvider.tsx`:

```tsx
/** Re-provide the theme with a pinned scheme (KDS is always carbon). */
export function ThemeScope({ scheme, children }: { scheme: ColorScheme; children: ReactNode }) {
  const parent = useThemeContext();           // existing hook
  const value = useMemo<ThemeContextValue>(() => ({
    ...parent,
    theme: buildTheme(null, scheme),          // branding is null on mobile today
  }), [parent, scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```
Wrap `kitchen.tsx`'s root in `<ThemeScope scheme="dark">`. Every primitive
inside picks up carbon automatically. (Also set the screen's own root
`backgroundColor: theme.colors.bg` as today.)

The KDS ticket card is the ONE deliberate inversion: tickets stay **paper**
on the carbon board. Inside `components/kitchen/TicketCard.tsx`, don't use
`Card` directly — build a local card with hardcoded-from-theme LIGHT surface:
`backgroundColor: INK_SCALE_LIGHT_V2[800]`-equivalent is NOT accessible from
theme when scoped dark… so import `inkScaleV2For('light')` from
`@cafe-mgmt/design-tokens` directly in TicketCard and use its `800/100/300`
for the card bg/ink/muted. This is an approved, documented exception to the
"theme only" rule (comment it). Urgency edge stays: 4px left border —
fresh → light-muted, warn → amber, urgent → `dangerFg`; timer `MonoText
weight="bold"` colored to match; qty `2×` amber mono bold 17+; item name
Inter semibold `2xl`. "Mark ready" button = ink-on-paper dark pill (see the
mockup). Ready column: same card + `Stamp tone="success" label="Ready"`.

- FlashList: `numColumns={useLayout().isTablet ? 2 : 1}`; give cards
  `maxWidth` ~560 so phone-landscape doesn't stretch.
- Motion: ticket arrival `entering={enterUp}`, leaving `exiting={exitFade}`,
  siblings `layout={listLayout}`. If FlashList recycling glitches cell
  entering-animations (visible as replays while scrolling), restrict to
  first-mount via a `hasAnimatedRef` per ticket id, or drop to animating the
  Stamp only — test on device, choose the stable option.
- Keep: segmented In progress/Ready control (extend `SegmentedField` with a
  count badge), the seen-tickets haptic effect, `partitionTickets`, the
  15s elapsed timer, read-only fallback, the excellent `EmptyBoard` copy
  (now via `ui/EmptyState`).
- ADD: `ErrorState` on fetch failure (defect: failures currently render as
  "No tickets cooking" — in a kitchen that's actively harmful).

### 7.2 Dashboard — `more/dashboard.tsx`
- KPIs → `Stat` (`size="lg"` for Sales, `md` grid for the rest; Net uses
  `tone={net >= 0 ? 'success' : 'danger'}`; house-tab caveat line becomes
  the `hint`). Loading → `Stat loading` (kills "Loading…" text).
- Payment-mix bar: keep the component, re-tone with `theme.colors.stamp`
  tone bgs/fgs; labels `MonoText size="2xs"`.
- SVG bar chart: keep hand-rolled; bars `theme.colors.primary` at full for
  the max day and `primaryTint` for others; axis labels mono 2xs; width via
  `useLayout()` (drop the direct `useWindowDimensions`).
- Range segmented control stays. Add `ErrorState` + skeleton grid.

Verification: KDS soak with live WS updates (open floor on a second device /
web, fire orders, watch animations under rapid invalidation); tablet 2-col;
full jest. Commit.

---

## 8. Phase 5 — cleanup, guardrails, assets

1. Delete `src/components/ui/Sheet.tsx` once nothing imports it (`grep -rn
   "from './Sheet'\|ui/Sheet" src/`), delete `more/gallery.tsx`.
2. Grep-gates (all must return ZERO in `src/`, excluding `ui/`):
   `width: '48%'` · `'›'` · `fontSize: [0-9]` outside `components/ui` ·
   `Ionicons` · `hexToRgba(` outside theme/ui · `animationType="slide"`.
3. Write `apps/mobile/MIGRATION.md`: the §4 table + the old→new component
   map, so the secondary-screens pass (history, more/*) is mechanical.
   That pass is OUT of scope here.
4. Brand assets in `apps/mobile/assets/images/`: several are still Expo
   template defaults. Regenerate: app icon = steaming-cup mark on carbon
   `#0f0e0b` (port from `apps/web/src/components/SteamingCup.tsx` paths);
   splash bg `#0f0e0b` + amber cup; android adaptive fg/bg + monochrome.
   Update `app.config.ts` splash/adaptive `backgroundColor` `#08070a` →
   `#0f0e0b`. (If asset generation tooling is unavailable, flag for the
   user instead of shipping placeholders.)
5. Final: full jest + lint + typecheck; device smoke iOS + physical Android
   + tablet landscape; both schemes; reduced-motion ON pass (no motion, no
   crashes); 2–3 moods. Commit.

### 8.3 Gorhom fallback (only if the user reports the gallery sheet broken)
Keep `AppSheet`'s API; swap its internals to the old RN `Modal` pattern +
`KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' :
'height'}` wrapping the sheet body + Reanimated slide-in. The keyboard
defect fix is non-negotiable; the spring physics are nice-to-have.

---

## 9. Test infra — read before writing ANY test (hard-won, will bite)

1. **Reanimated cannot load under Jest** (worklets binds native at import;
   even the shipped `/mock` pulls initializers). A hand-rolled mock lives in
   `apps/mobile/jest.setup.ts`. If you use a new export (e.g. `ZoomIn`,
   `withSequence` behavior, `useAnimatedScrollHandler`), ADD it to that mock
   or every suite fails at transform/require time.
2. **gorhom mock** in jest.setup.ts overrides `BottomSheetModal` to be
   visibility-faithful (present/dismiss toggle + fires `onDismiss`). Don't
   replace it with the shipped mock (renders children unconditionally).
3. **RNTL v14 + React 19**: `render` is async → `await renderWithProviders(…)`.
   State-changing interactions MUST be `userEvent`:
   `const user = userEvent.setup(); await user.press(el)` /
   `user.paste/clear/type`. `fireEvent` does NOT flush async act — queries
   go stale and, worse, the unflushed work poisons LATER tests in the same
   file ("overlapping act() calls", inexplicably-empty trees). `fireEvent`
   is only safe when the handler is a pure `jest.fn()` with no state update.
4. `renderWithProviders(…).rerender` re-wraps in providers (fixed in
   `src/test-utils/index.tsx`) — never call RNTL's raw rerender with an
   unwrapped element.
5. Test `QueryClient`s: `gcTime: Infinity` + `client.clear()` in afterEach,
   else TanStack's 5-min GC timers trip Jest's open-handle detector.
6. jest.mock factories: no type annotations whose param names look like
   out-of-scope identifiers (babel-jest-hoist rejects `(p: object) => …`).
7. Coverage gates in `jest.config.js` are real: `buildTheme.ts` must stay
   100/100/100/100. Route files (`src/app/**`) are excluded from coverage.
8. `AGENTS.md` says: Expo APIs changed — check
   https://docs.expo.dev/versions/v57.0.0/ before using an unfamiliar API.

---

## 10. Definition of done, per phase

- typecheck + lint (`--max-warnings 0`) + `jest --silent --coverage` green.
- No grep-gate regressions (§8.2 list — run them early, not just at P5).
- A11y labels stable or tests updated in the same commit.
- On-device check for the phase's surface (dev client: `pnpm start` in
  `apps/mobile`).
- One commit per phase, message style: `Mobile redesign Phase N: <summary>`
  + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NO push.
- After Phase 2: STOP for user review before continuing.

## 11. Design self-review (before showing the user)

Squint test per screen: Is the number the hero? Is amber < 10% of the
pixels? Is Fraunces at most one moment? Do all statuses read as stamps? Are
leaders/perforation present on the docket surfaces (and NOWHERE else)? Does
light mode read like paper (warm, layered) rather than "dark mode inverted"?
Would a cafe owner screenshot this? If any answer is no, fix before review.
