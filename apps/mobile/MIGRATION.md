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

## Status: the secondary-screens pass is DONE ✅

The whole app is now on the primitives, in both light and dark. Completed:
- **Restyled** onto the primitives (Card/ListRow/Section/Stamp/Stat/EmptyState/
  ErrorState + MonoText for numbers; loading/error/empty states added):
  `history.tsx`, `components/OfflineBanner.tsx`, and `more/{menu, tables,
  inventory, team, shift, expenses, super, settings, printing, sync-review,
  feedback}`.
- **`ui/Sheet` → `AppSheet`** in all 7 form screens (+ `components/menu/
  ShareMenuSheet.tsx`); sheet inputs → `AppSheet.TextInput`, money →
  `AmountInput insideSheet`, primary actions → AppSheet `footer`. Then
  **`src/components/ui/Sheet.tsx` was deleted** (removing the last
  `animationType="slide"`).
- **Grep-gates are zero** across `src/` (excluding `ui/`/`theme/`): no
  `hexToRgba(`, `'›'`, literal `fontSize: <n>`, `Ionicons`, `width:'48%'`, or
  `animationType="slide"`. typecheck + lint + jest --coverage green.

Gate commands (all return nothing now):
```
grep -rn "hexToRgba(" src | grep -vE "/ui/|/theme/"
grep -rn "›" src | grep -vE "/ui/"
grep -rn "fontSize: [0-9]" src | grep -v "/components/ui/"
grep -rn "Ionicons\|width: '48%'\|animationType=\"slide\"" src | grep -vE "/ui/"
```

### Still open
- `src/app/(app)/more/gallery.tsx` — the dev primitive gallery (deep-link
  `goserve://more/gallery`). **Kept** as the on-device reduced-motion / mood /
  primitive check. Delete before store submission.

## Brand assets — NEEDS DESIGN TOOLING (flagged)
`app.config.ts` splash + adaptive-icon `backgroundColor` are now `#0f0e0b`
(carbon). The icon PNGs in `assets/images/` are still Expo-template defaults and
need regenerating: app icon = steaming-cup mark on `#0f0e0b` (port the paths
from `apps/web/src/components/SteamingCup.tsx`), Android adaptive
foreground/background/monochrome, and `splash-icon.png`.
This machine has no SVG rasterizer (`sharp`/`resvg`/`rsvg-convert`/Inkscape
absent; only `sips`, which can't render SVG), so these were **not** generated —
regenerate with a design pipeline rather than ship placeholders.
