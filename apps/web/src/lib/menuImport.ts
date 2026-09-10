// The bulk menu-import format now lives in `@cafe-mgmt/menu-import`, shared
// with the phone — two tolerant parsers drifting apart would mean the same
// pasted JSON succeeding on one client and failing on the other.
//
// This module binds it to WEB's icon registry. The allow-list is an argument
// in the shared package precisely because the two apps ship different
// registries: a name web knows and mobile does not must drop on mobile rather
// than arrive as a broken glyph.
import {
  buildImportPrompt,
  parseImportJson as parseWithIcons,
  countDraftItems,
  type ImportCategoryDraft,
  type ImportItemDraft,
} from '@cafe-mgmt/menu-import';
import { ICON_REGISTRY } from '@/components/icons';

const ICON_NAMES = Object.keys(ICON_REGISTRY);

export const IMPORT_PROMPT = buildImportPrompt(ICON_NAMES);

export function parseImportJson(text: string): ImportCategoryDraft[] {
  return parseWithIcons(text, ICON_NAMES);
}

export { countDraftItems };
export type { ImportCategoryDraft, ImportItemDraft };
