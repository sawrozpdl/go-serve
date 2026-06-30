import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardCopy, Upload, Plus, Trash2, ArrowLeft, CheckCircle2, Sparkles } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { parsePriceInput } from '@/components/Money';
import { toast } from '@/lib/toast';
import { IMPORT_PROMPT, parseImportJson, type ImportCategoryDraft } from '@/lib/menuImport';
import { useMenuCategories, useMenuItems, useBulkImportMenu, type ApiError } from '@/lib/api';

type Props = { open: boolean; onClose: () => void };

// NUL separator for the category∥item match key — can't appear in a name.
const SEP = '\u0000';
type RowStatus = 'new' | 'update' | 'skip';

// Where to move an item via its category dropdown.
type MoveTarget =
  | { type: 'index'; index: number } // an existing draft section
  | { type: 'name'; name: string } //   an existing tenant category not yet shown
  | { type: 'new' }; //                 a brand-new, unnamed section

const blankItem = () => ({ name: '', price: '', description: '', icon: '' });
const blankCat = (): ImportCategoryDraft => ({ name: '', icon: '', items: [blankItem()] });

const priceInvalid = (p: string) => {
  const c = parsePriceInput(p);
  return c == null || c <= 0;
};

/**
 * Bulk menu import — paste the JSON an AI assistant produced from a photo of the
 * menu, review/fix it (grouped by category, with NEW / UPDATE / SKIP badges),
 * then commit it in one transactional upsert. Three steps in one wide modal:
 * a fixed footer holds the actions, only the list scrolls.
 */
export function BulkImportMenuModal({ open, onClose }: Props) {
  const cats = useMenuCategories();
  const items = useMenuItems(); // all items, for NEW-vs-existing detection
  const imp = useBulkImportMenu();

  const [step, setStep] = useState<'input' | 'review' | 'done'>('input');
  const [rawText, setRawText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ImportCategoryDraft[]>([]);
  const [overwrite, setOverwrite] = useState(true);
  const [result, setResult] = useState<{
    catCreated: number;
    catUpdated: number;
    itemCreated: number;
    itemUpdated: number;
    itemSkipped: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset to a clean slate every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep('input');
    setRawText('');
    setParseError(null);
    setDrafts([]);
    setOverwrite(true);
    setResult(null);
  }, [open]);

  // Existing names → NEW/UPDATE/SKIP badges, matching the server's lower(name)
  // rule (categories by name, items by category+name).
  const existing = useMemo(() => {
    const catNameById = new Map<string, string>();
    const catNames = new Set<string>();
    (cats.data ?? []).forEach((c) => {
      const lower = c.name.toLowerCase();
      catNameById.set(c.id, lower);
      catNames.add(lower);
    });
    const itemKeys = new Set<string>();
    (items.data ?? []).forEach((i) => {
      const cn = catNameById.get(i.category_id);
      if (cn != null) itemKeys.add(cn + SEP + i.name.toLowerCase());
    });
    return { catNames, itemKeys };
  }, [cats.data, items.data]);

  const itemStatus = (catName: string, itemName: string): RowStatus => {
    const key = catName.trim().toLowerCase() + SEP + itemName.trim().toLowerCase();
    if (existing.itemKeys.has(key)) return overwrite ? 'update' : 'skip';
    return 'new';
  };
  const catExists = (name: string) => existing.catNames.has(name.trim().toLowerCase());

  // Existing tenant categories not already shown as a draft section — offered in
  // the per-item dropdown so an item can be filed under one without retyping it.
  const existingOnlyCats = useMemo(() => {
    const draftNames = new Set(drafts.map((c) => c.name.trim().toLowerCase()));
    return (cats.data ?? []).map((c) => c.name).filter((n) => !draftNames.has(n.trim().toLowerCase()));
  }, [cats.data, drafts]);

  // ---- draft mutators (immutable) ----------------------------------------
  const patchCat = (ci: number, patch: Partial<ImportCategoryDraft>) =>
    setDrafts((ds) => ds.map((c, i) => (i === ci ? { ...c, ...patch } : c)));
  const patchItem = (ci: number, ii: number, patch: Partial<ImportCategoryDraft['items'][number]>) =>
    setDrafts((ds) =>
      ds.map((c, i) => (i === ci ? { ...c, items: c.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : c)),
    );
  const removeItem = (ci: number, ii: number) =>
    setDrafts((ds) => ds.map((c, i) => (i === ci ? { ...c, items: c.items.filter((_, j) => j !== ii) } : c)));
  const removeCat = (ci: number) => setDrafts((ds) => ds.filter((_, i) => i !== ci));
  const addItem = (ci: number) =>
    setDrafts((ds) => ds.map((c, i) => (i === ci ? { ...c, items: [...c.items, blankItem()] } : c)));
  const addCat = () => setDrafts((ds) => [...ds, blankCat()]);

  // Move an item to another category (always a safe pick — never free-typed).
  const moveItem = (ci: number, ii: number, target: MoveTarget) =>
    setDrafts((ds) => {
      const item = ds[ci]?.items[ii];
      if (!item) return ds;
      const without = ds.map((c, i) => (i === ci ? { ...c, items: c.items.filter((_, j) => j !== ii) } : c));
      if (target.type === 'index') {
        return without.map((c, i) => (i === target.index ? { ...c, items: [...c.items, item] } : c));
      }
      if (target.type === 'name') {
        const tj = without.findIndex((c) => c.name.trim().toLowerCase() === target.name.trim().toLowerCase());
        if (tj >= 0) return without.map((c, i) => (i === tj ? { ...c, items: [...c.items, item] } : c));
        return [...without, { name: target.name, icon: '', items: [item] }];
      }
      return [...without, { name: '', icon: '', items: [item] }];
    });

  const onCategoryPick = (ci: number, ii: number, value: string) => {
    if (value === String(ci)) return; // unchanged
    if (value === '__new__') return moveItem(ci, ii, { type: 'new' });
    if (value.startsWith('existing:')) return moveItem(ci, ii, { type: 'name', name: value.slice(9) });
    moveItem(ci, ii, { type: 'index', index: Number(value) });
  };

  // ---- step 1: input -----------------------------------------------------
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      toast.success('Prompt copied', 'Paste it into ChatGPT (or any AI assistant) with a photo of your menu.');
    } catch {
      toast.error('Could not copy — select the prompt text manually.');
    }
  };
  const readFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => setRawText(String(reader.result ?? ''));
    reader.onerror = () => toast.error('Could not read that file.');
    reader.readAsText(f);
  };
  const handleParse = () => {
    try {
      setDrafts(parseImportJson(rawText));
      setParseError(null);
      setStep('review');
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  // ---- step 2: review tally + validity -----------------------------------
  const tally = useMemo(() => {
    let nNew = 0;
    let nUpd = 0;
    let nSkip = 0;
    drafts.forEach((c) =>
      c.items.forEach((it) => {
        const s = itemStatus(c.name, it.name);
        if (s === 'new') nNew++;
        else if (s === 'update') nUpd++;
        else nSkip++;
      }),
    );
    const newCats = drafts.filter((c) => !catExists(c.name)).length;
    return { nNew, nUpd, nSkip, newCats, totalCats: drafts.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, existing, overwrite]);

  const hasInvalid =
    drafts.length === 0 ||
    drafts.some((c) => !c.name.trim() || c.items.some((it) => !it.name.trim() || priceInvalid(it.price)));
  const nothingToDo = tally.nNew + tally.nUpd === 0;
  const willChange = tally.nNew + tally.nUpd;

  const handleImport = async () => {
    try {
      const res = await imp.mutateAsync({
        overwrite_existing: overwrite,
        categories: drafts.map((c) => ({
          name: c.name.trim(),
          icon: c.icon || undefined,
          items: c.items.map((it) => ({
            name: it.name.trim(),
            description: it.description.trim() || undefined,
            icon: it.icon || undefined,
            price_cents: parsePriceInput(it.price) ?? 0,
          })),
        })),
      });
      setResult({
        catCreated: res.categories.created,
        catUpdated: res.categories.updated,
        itemCreated: res.items.created,
        itemUpdated: res.items.updated,
        itemSkipped: res.items.skipped,
      });
      setStep('done');
    } catch (e) {
      toast.error((e as ApiError).message || 'Import failed');
    }
  };

  const subtitle =
    step === 'input'
      ? 'Turn a photo of your menu into items — with a little help from an AI assistant'
      : step === 'review'
        ? 'Review and fix before anything is saved'
        : 'All done';

  // Footer (pinned) — actions live here so only the list scrolls.
  let footer: ReactNode = null;
  if (step === 'input') {
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={handleParse} disabled={!rawText.trim()}>
          <Sparkles size={14} strokeWidth={1.6} /> Parse &amp; preview
        </button>
      </>
    );
  } else if (step === 'review') {
    footer = (
      <>
        <button type="button" className="btn" onClick={() => setStep('input')}>
          <ArrowLeft size={14} strokeWidth={1.6} /> Back
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleImport}
          disabled={hasInvalid || nothingToDo || imp.isPending}
          title={nothingToDo ? 'Nothing to import — every item already exists' : undefined}
        >
          {imp.isPending ? 'Importing…' : `Import ${willChange} item${willChange === 1 ? '' : 's'}`}
        </button>
      </>
    );
  } else {
    footer = (
      <button type="button" className="btn primary" onClick={onClose}>
        Done
      </button>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import menu"
      subtitle={subtitle}
      size="wide"
      footer={footer}
      bodyClassName={step === 'review' ? 'import-review-body' : undefined}
    >
      {step === 'input' && (
        <div className="import-input">
          <ol className="import-steps">
            <li>
              <span className="import-step-n">1</span>
              <div className="import-step-body">
                <span>Copy the prompt below.</span>
                <button type="button" className="btn import-copy" onClick={copyPrompt}>
                  <ClipboardCopy size={14} strokeWidth={1.6} /> Copy prompt
                </button>
              </div>
            </li>
            <li>
              <span className="import-step-n">2</span>
              <span>
                Paste it into <strong>ChatGPT</strong> (or any AI assistant) along with a clear photo or PDF of your menu.
              </span>
            </li>
            <li>
              <span className="import-step-n">3</span>
              <span>Paste the JSON it gives back into the box below.</span>
            </li>
          </ol>

          <label>Menu JSON</label>
          <textarea
            className="import-textarea"
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              if (parseError) setParseError(null);
            }}
            placeholder={'{\n  "categories": [\n    { "name": "Hot Coffee", "items": [ { "name": "Espresso", "price": 120 } ] }\n  ]\n}'}
            spellCheck={false}
            autoFocus
          />
          {parseError && <div className="field-error">{parseError}</div>}

          <div className="import-input-foot">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Upload size={14} strokeWidth={1.6} /> Upload .json
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
                e.target.value = '';
              }}
            />
            <span className="field-hint" style={{ margin: 0 }}>
              No photos are imported — add item photos later from the menu editor.
            </span>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="import-review">
          {/* Sticky controls bar — counts + overwrite toggle. */}
          <div className="import-summary">
            <div className="import-summary-counts">
              <span className="import-badge new">{tally.nNew} new</span>
              {tally.nUpd > 0 && <span className="import-badge update">{tally.nUpd} update</span>}
              {tally.nSkip > 0 && <span className="import-badge skip">{tally.nSkip} skip</span>}
              <span className="import-summary-cats">
                in {tally.totalCats} categor{tally.totalCats === 1 ? 'y' : 'ies'}
                {tally.newCats > 0 && ` (${tally.newCats} new)`}
              </span>
            </div>
            <div className="import-overwrite">
              <button
                type="button"
                className={`switch${overwrite ? ' on' : ''}`}
                aria-pressed={overwrite}
                aria-label="Overwrite items that already exist"
                onClick={() => setOverwrite((v) => !v)}
              >
                <span className="switch-knob" />
              </button>
              <span className="import-overwrite-label">Update items that already exist</span>
            </div>
          </div>

          {/* Scrolling list — the only thing that scrolls. */}
          <div className="import-cats">
            {drafts.map((c, ci) => {
              const cExists = catExists(c.name);
              return (
                <div className="import-cat" key={ci}>
                  <div className="import-cat-head">
                    <span className={`import-badge ${cExists ? 'existing' : 'new'}`}>{cExists ? 'Existing' : 'New'}</span>
                    <input
                      className={`import-cat-name ${!c.name.trim() ? 'invalid' : ''}`}
                      value={c.name}
                      onChange={(e) => patchCat(ci, { name: e.target.value })}
                      placeholder="Category name"
                      aria-label="Category name"
                    />
                    <button
                      type="button"
                      className="btn icon danger import-cat-remove"
                      aria-label="Remove category"
                      title="Remove this category and its items"
                      onClick={() => removeCat(ci)}
                    >
                      <Trash2 size={14} strokeWidth={1.6} />
                    </button>
                  </div>

                  <div className="import-item-head" aria-hidden>
                    <span />
                    <span>Item</span>
                    <span>Price</span>
                    <span>Notes</span>
                    <span>Category</span>
                    <span />
                  </div>

                  {c.items.map((it, ii) => {
                    const status = it.name.trim() ? itemStatus(c.name, it.name) : 'new';
                    return (
                      <div className="import-item-row" key={ii}>
                        <span className={`import-badge ${status}`}>{status}</span>
                        <input
                          className={`import-item-name ${!it.name.trim() ? 'invalid' : ''}`}
                          value={it.name}
                          onChange={(e) => patchItem(ci, ii, { name: e.target.value })}
                          placeholder="Item name"
                          aria-label="Item name"
                        />
                        <div className="import-price">
                          <span className="import-price-cur" aria-hidden>
                            रू
                          </span>
                          <input
                            className={`import-price-input ${priceInvalid(it.price) ? 'invalid' : ''}`}
                            value={it.price}
                            inputMode="decimal"
                            onChange={(e) => patchItem(ci, ii, { price: e.target.value })}
                            placeholder="0"
                            aria-label="Price"
                          />
                        </div>
                        <input
                          className="import-item-desc"
                          value={it.description}
                          onChange={(e) => patchItem(ci, ii, { description: e.target.value })}
                          placeholder="Optional"
                          aria-label="Notes"
                        />
                        <select
                          className="import-item-cat"
                          value={String(ci)}
                          onChange={(e) => onCategoryPick(ci, ii, e.target.value)}
                          aria-label="Category"
                        >
                          {drafts.map((dc, j) => (
                            <option key={j} value={String(j)}>
                              {dc.name.trim() || '(unnamed)'}
                            </option>
                          ))}
                          {existingOnlyCats.length > 0 && (
                            <optgroup label="Existing categories">
                              {existingOnlyCats.map((n) => (
                                <option key={`e:${n}`} value={`existing:${n}`}>
                                  {n}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <option value="__new__">+ New category…</option>
                        </select>
                        <button
                          type="button"
                          className="btn icon danger"
                          aria-label="Remove item"
                          title="Remove item"
                          onClick={() => removeItem(ci, ii)}
                        >
                          <Trash2 size={13} strokeWidth={1.6} />
                        </button>
                      </div>
                    );
                  })}

                  <button type="button" className="btn import-add-item" onClick={() => addItem(ci)}>
                    <Plus size={13} strokeWidth={1.7} /> Add item
                  </button>
                </div>
              );
            })}

            <button type="button" className="btn import-add-cat" onClick={addCat}>
              <Plus size={14} strokeWidth={1.7} /> Add category
            </button>

            {hasInvalid && (
              <div className="field-error import-invalid">Every item needs a name and a price greater than 0.</div>
            )}
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="import-done">
          <CheckCircle2 size={40} strokeWidth={1.4} className="import-done-icon" />
          <h4>Menu imported</h4>
          <p>
            {result.itemCreated} new item{result.itemCreated === 1 ? '' : 's'}
            {result.itemUpdated > 0 && `, ${result.itemUpdated} updated`}
            {result.itemSkipped > 0 && `, ${result.itemSkipped} skipped`} across{' '}
            {result.catCreated + result.catUpdated} categor
            {result.catCreated + result.catUpdated === 1 ? 'y' : 'ies'}
            {result.catCreated > 0 && ` (${result.catCreated} new)`}.
          </p>
        </div>
      )}
    </Modal>
  );
}
