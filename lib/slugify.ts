/**
 * Canonical slug generator.
 *
 * Always strips diacritics first (NFD + combining-mark removal) so accented
 * characters round-trip to their ASCII base before the [a-z0-9] filter
 * collapses everything else. Without this, "Agenda Médica" became
 * "agenda-m-dica" because `é` doesn't match [a-z]; with it, → "agenda-medica".
 *
 * Cedilla (ç) decomposes as `c` + U+0327 in NFD, so the same pass cleans it.
 *
 * Use the `keepDashes` option for slug-edit fields where the operator is
 * typing a slug directly and should be allowed to keep `-` while we strip
 * everything else.
 */
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

export function slugify(text: string, opts: { maxLength?: number; keepDashes?: boolean } = {}): string {
  const maxLength = opts.maxLength ?? 60;
  const filter    = opts.keepDashes ? /[^a-z0-9-]+/g : /[^a-z0-9]+/g;
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(filter, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);
}
