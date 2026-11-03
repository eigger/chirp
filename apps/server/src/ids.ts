import { slug } from "./diskIdentity.js";

/**
 * Turn display names into stable `[a-z0-9_]+` IDs. Duplicates (in the given,
 * deterministic order) get `_2`, `_3`, ... suffixes; an empty slug becomes
 * `fallback`.
 */
export function uniqueIds(names: string[], fallback: string): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = slug(name) || fallback;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  });
}
