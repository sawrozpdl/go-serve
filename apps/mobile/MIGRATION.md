# Docket redesign — secondary-screens migration guide

Phases 0–4 of the "Docket" redesign are done: the token seam, the primitive
library, and every high-traffic surface (login/OTP, floor, order detail + menu,
settle, KDS, dashboard, tab bar) are rebuilt on the primitives. This doc is for
the **remaining mechanical pass**: the secondary `more/*` detail screens +
history internals + `OfflineBanner`, which still use pre-redesign patterns.

It is intentionally checklist-shaped — no new decisions, just apply the map.

## The primitive library (`src/components/ui/`)

Compose screens from these — never hand-roll the equivalent.

| Primitive | Use for | Key props |
|---|---|---|
| `Card` | any elevated paper surface | `level 2\|3, selected, elevated, padded, onPress` |
| `Stamp` | ALL status chips | `label, tone neutral\|info\|warn\|success\|danger\|brand, size sm\|md, dot` |
| `Chip` | selectable filters/tenders/toggles | `label, selected, onPress, icon, count` |
| `ListRow` | settings/detail rows | `title, subtitle, left, value (mono), right, chevron, destructive, onPress` |
| `Section` | titled blocks | `title, count, action` (mono eyebrow + dotted leader) |
| `Stat` | KPI tiles | `label, value, size md\|lg, tone, hint, loading` |
| `EmptyState` | empty lists/boards | `icon, title, hint, action` |
| `ErrorState` | FAILED fetches (not empty!) | `title?, detail?, onRetry` |
| `Skeleton` / `Skeleton.Card` | loading | `width, height, radius` / `lines` |
| `Stepper` | ALL qty steppers | `value, onIncrement, onDecrement, min, max, size md\|lg, label` |
| `AmountInput` | money entry | `valueCents, onChangeCents, quickAmounts, insideSheet, error` |
| `AppSheet` | ALL bottom sheets | `open, onClose, title, full, rightAction, footer` + `.ScrollView/.TextInput` |
| `Button` | buttons | `title, variant primary\|secondary\|ghost, loading` |
| `MonoText` / `Heading` / `AppText` (`Text.tsx`) | numbers / Fraunces moments / body | `size, weight, muted` / `size` / `variant` |
| `DottedLeader` · `Perforation` | docket leaders / tear line | (parent needs `overflow:'hidden'` for Perforation) |

## Old → new mapping

| Old pattern | Replace with |
|---|---|
| `import { Sheet } from '@/components/ui/Sheet'` | `AppSheet` (`open`/`onClose` API is identical); inputs inside → `AppSheet.TextInput`, scroll → `AppSheet.ScrollView` |
| hand-rolled `Row` (border card + `›` glyph) | `ListRow` (or keep the card + swap `›` → Lucide `ChevronRight`) |
| `hexToRgba(color, 0.16)` status chip | `Stamp` (tone bg/border are opaque, elevation-safe) |
| `fontSize: 26/30/…` literal | `Heading size=` / `MonoText size=` / `AppText` + `theme.typeStyles[key].size` |
| `width: '48%'` grid | `ui/Grid columns={useLayout().columns(target,min,max)}` |
| `'›'` glyph | Lucide `ChevronRight` (or `ListRow chevron`) |
| local `Kpi` / progress-bar / hand SVG | `Stat` / re-tone with `theme.colors.stamp` tones |
| forced-scheme surface (e.g. KDS) | wrap in `<ThemeScope scheme="dark">` |

## Remaining work (the mechanical pass)

### 1. Migrate `ui/Sheet` → `AppSheet`, then delete `ui/Sheet.tsx`
Still importing the old `Sheet` (7 screens):
`more/team.tsx`, `more/inventory.tsx`, `more/shift.tsx`, `more/super.tsx`,
`more/tables.tsx`, `more/menu.tsx`, `more/expenses.tsx`.
Once all are on `AppSheet`, delete `src/components/ui/Sheet.tsx` (it's the last
`animationType="slide"` in the app).
NB: `AppSheet` has a fix (see [[mobile-redesign-docket]]) — it only presents via
a button because it no longer calls `dismiss()` on the initial closed mount.

### 2. Drive the grep-gates to zero (run in `src/`, excluding `ui/` and `theme/`)
The redesigned surfaces are already clean; these files remain:
- **`hexToRgba(`**: `history.tsx`, `more/inventory.tsx`, `more/team.tsx`,
  `more/super.tsx`, `more/feedback.tsx`, `components/OfflineBanner.tsx`.
- **`'›'` glyph**: `components/OfflineBanner.tsx` (code), `history.tsx` (comment only).
- **`fontSize: [0-9]`**: `history.tsx`, `more/super.tsx`.
- **`Ionicons` / `width: '48%'` / `animationType="slide"`**: none outside `ui/`
  (Grid.tsx + a layout.ts comment are the only `48%` hits; `slide` is only in
  `ui/Sheet.tsx`, gone once step 1 lands).

Gate commands:
```
grep -rn "hexToRgba(" src | grep -vE "/ui/|/theme/"
grep -rn "›" src | grep -vE "/ui/"
grep -rn "fontSize: [0-9]" src | grep -v "/components/ui/"
grep -rn "Ionicons\|width: '48%'\|animationType=\"slide\"" src | grep -vE "/ui/"
```

### 3. Restyle the secondary screens on the primitives
`more/{menu,tables,inventory,team,shift,expenses,super,settings,printing,
sync-review,feedback}` and `history.tsx` still use pre-redesign card/row/kpi
patterns. Apply the map above (Card/ListRow/Section/Stamp/Stat/EmptyState/
ErrorState + MonoText for numbers). Keep a11y labels + copy stable (tests select
by them); pin any header/filter above the scroll (see floor/kitchen/history/
dashboard for the pattern).

### 4. Cleanup
- `src/app/(app)/more/gallery.tsx` — the dev primitive gallery (deep-link
  `goserve://more/gallery`). **Kept** for now: it's the on-device
  reduced-motion / mood / primitive check. Delete before store submission.

## Brand assets — NEEDS DESIGN TOOLING (flagged)
`app.config.ts` splash + adaptive-icon `backgroundColor` are now `#0f0e0b`
(carbon). The icon PNGs in `assets/images/` are still Expo-template defaults and
need regenerating: app icon = steaming-cup mark on `#0f0e0b` (port the paths
from `apps/web/src/components/SteamingCup.tsx`), Android adaptive
foreground/background/monochrome, and `splash-icon.png`.
This machine has no SVG rasterizer (`sharp`/`resvg`/`rsvg-convert`/Inkscape
absent; only `sips`, which can't render SVG), so these were **not** generated —
regenerate with a design pipeline rather than ship placeholders.
