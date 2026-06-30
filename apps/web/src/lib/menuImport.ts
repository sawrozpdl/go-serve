// Helpers for the bulk menu import flow.
//
// The onboarding story: the operator copies IMPORT_PROMPT, pastes it into
// ChatGPT together with a photo of their existing (paper/PDF) menu, and ChatGPT
// returns JSON in the shape below. They paste that JSON back here; we parse it
// tolerantly into an editable draft, let them fix it, then POST /v1/menu/import.
//
//   { "categories": [
//       { "name": "Hot Coffee", "icon": "Coffee",
//         "items": [ { "name": "Espresso", "price": 120, "description": "…", "icon": "Coffee" } ] } ] }
//
// Prices are MAJOR currency units (120 = रू120) — we convert to price_cents on
// submit. Icons are optional Lucide names from our registry; anything we don't
// recognise is dropped (the item still imports, just without an icon).

import { ICON_REGISTRY } from '@/components/icons';

/** Editable draft of one item in the review step. `price` is text in major
 *  units so the user can type freely; it's parsed to cents on submit. */
export type ImportItemDraft = {
  name: string;
  price: string;
  description: string;
  icon: string;
};

// Kitchen routing is intentionally NOT part of the import — items default to
// 'inherit' and the owner tunes cook/ready/serve later in the Menu editor.
export type ImportCategoryDraft = {
  name: string;
  icon: string;
  items: ImportItemDraft[];
};

// ---------------------------------------------------------------------------
// The prompt. Built once from the live icon registry so the allow-list never
// drifts from what the picker actually supports.
// ---------------------------------------------------------------------------

const ICON_NAMES = Object.keys(ICON_REGISTRY).join(', ');

// Model-agnostic. Written so any vision LLM (ChatGPT, Claude, Gemini, …) returns
// a single strictly-valid JSON object. The parser below is still tolerant of
// stray prose/fences, but a strong prompt keeps weaker models on the rails.
export const IMPORT_PROMPT = `You are a precise menu-digitisation assistant.

I will give you a photo or PDF of a café/restaurant menu. Extract every item you can read and return the result as ONE JSON object.

OUTPUT CONTRACT — this is strict:
- Return ONLY the JSON object. No explanation, no markdown, no code fences, no text before or after it.
- Your reply must start with "{" and end with "}".
- It must be valid JSON: double quotes around every key and string, no trailing commas, no comments, and numbers left unquoted.

Use exactly this schema (required fields marked; omit optional fields you can't fill rather than sending null or ""):

{
  "categories": [
    {
      "name": "string  — section/heading name (REQUIRED)",
      "icon": "string  — optional, see icon list",
      "items": [
        {
          "name": "string  — item name (REQUIRED)",
          "price": 0,       // number — REQUIRED, see price rules
          "description": "string  — optional, short",
          "icon": "string  — optional, see icon list"
        }
      ]
    }
  ]
}

RULES
1. price: a plain number in the menu's own currency — NO currency symbol, NO thousands separators, NO units. Write 120, 80, 1500 (keep decimals if shown, e.g. 4.50). Never write "Rs. 120" or "120/-".
2. One price per item. If an item lists several sizes/prices (Small/Large, 12oz/16oz), output a SEPARATE item for each, putting the size in the name: "Latte (Small)", "Latte (Large)".
3. Group items under the headings printed on the menu. If the menu has no headings, infer a few sensible categories (e.g. "Drinks", "Food").
4. description: keep it under ~80 characters, or omit the field entirely.
5. icon (optional): only use a value from this EXACT list (case-sensitive). If nothing fits, OMIT the icon field — never invent or guess a name:
   ${ICON_NAMES}
6. Do NOT invent items, prices, or categories that are not on the menu. Skip anything you cannot read with confidence.
7. If you cannot read any items at all, return exactly: {"categories": []}

EXAMPLE (format only — use the real menu):
{"categories":[{"name":"Hot Coffee","icon":"Coffee","items":[{"name":"Espresso","price":120,"description":"Single shot"},{"name":"Latte","price":180}]},{"name":"Pastries","icon":"Croissant","items":[{"name":"Almond Croissant","price":160}]}]}`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strip markdown fences / surrounding prose and parse the embedded JSON.
 *  LLMs often wrap output in ```json … ``` or add a sentence before it. */
function extractJson(text: string): unknown {
  let t = text.trim();
  if (!t) throw new Error('Paste the JSON from your AI assistant first.');

  // Prefer a fenced block if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();

  // Fast path: it's already clean JSON.
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to brace-slicing */
  }

  // Slice from the first opening brace/bracket to the last closing one.
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  const ends = [t.lastIndexOf('}'), t.lastIndexOf(']')];
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(...ends);
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error("That doesn't look like valid JSON. Paste the whole JSON object your AI assistant returned.");
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function cleanIcon(v: unknown): string {
  const name = asString(v);
  return name && ICON_REGISTRY[name] ? name : '';
}

/** Coerce a raw price (number or string, major units, or price_cents) into the
 *  editable major-unit text. Returns '' when unreadable so the row flags it. */
function priceToText(raw: Record<string, unknown>): string {
  if (raw.price != null) {
    const n = typeof raw.price === 'number' ? raw.price : parseFloat(asString(raw.price));
    if (Number.isFinite(n)) return String(n);
  }
  if (raw.price_cents != null) {
    const n = typeof raw.price_cents === 'number' ? raw.price_cents : parseFloat(asString(raw.price_cents));
    if (Number.isFinite(n)) return String(n / 100);
  }
  return '';
}

/** Parse pasted/uploaded text into editable drafts. Throws a friendly Error on
 *  malformed input or a structurally wrong payload. */
export function parseImportJson(text: string): ImportCategoryDraft[] {
  const root = extractJson(text);

  // Accept either {categories:[…]} or a bare array of categories.
  const rawCats = Array.isArray(root)
    ? root
    : (root as { categories?: unknown })?.categories;
  if (!Array.isArray(rawCats)) {
    throw new Error('Expected a "categories" array. Re-run the prompt and paste the full JSON.');
  }

  const cats: ImportCategoryDraft[] = [];
  for (const rc of rawCats) {
    if (!rc || typeof rc !== 'object') continue;
    const c = rc as Record<string, unknown>;
    const name = asString(c.name);
    if (!name) continue; // skip headless categories silently

    const rawItems = Array.isArray(c.items) ? c.items : [];
    const items: ImportItemDraft[] = [];
    for (const ri of rawItems) {
      if (!ri || typeof ri !== 'object') continue;
      const it = ri as Record<string, unknown>;
      const iname = asString(it.name);
      if (!iname) continue;
      items.push({
        name: iname,
        price: priceToText(it),
        description: asString(it.description),
        icon: cleanIcon(it.icon),
      });
    }

    cats.push({
      name,
      icon: cleanIcon(c.icon),
      items,
    });
  }

  if (cats.length === 0) {
    throw new Error('No categories with items were found in that JSON.');
  }
  return cats;
}

/** Total items across all draft categories. */
export function countDraftItems(cats: ImportCategoryDraft[]): number {
  return cats.reduce((n, c) => n + c.items.length, 0);
}
