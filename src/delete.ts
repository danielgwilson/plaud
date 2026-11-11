// Permanent deletion of recordings that are already in the trash (the web app's "Delete permanently").

export class DeleteInputError extends Error {}

export type DeletePlan = { deletable: Array<{ id: string; name: string }>; notFound: string[]; notInTrash: Array<{ id: string; name: string }> };

/** Sort the requested ids into: safe to delete (in trash), not found, and refused (still active). */
/** Ids are cleaned once, before any lookup. For an irreversible action, odd-looking ids are refused outright. */
export function cleanIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw);
    if (!id.trim()) continue;
    if (id !== id.trim() || /[\s,]/.test(id)) throw new DeleteInputError(`"${id}" does not look like a recording id (no spaces or commas). Nothing was deleted.`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new DeleteInputError("Pass at least one recording id.");
  return out;
}

export function planPermanentDelete(ids: string[], details: any[]): DeletePlan {
  const unique = cleanIds(ids);
  const byId = new Map<string, any>();
  for (const d of Array.isArray(details) ? details : []) {
    if (!d?.id) continue;
    const key = String(d.id);
    const seen = byId.get(key);
    // Two records for one id that disagree about the trash: refuse rather than let the last one win.
    if (seen && (seen.is_trash === true) !== (d.is_trash === true)) byId.set(key, { ...d, is_trash: false });
    else if (!seen) byId.set(key, d);
  }
  const plan: DeletePlan = { deletable: [], notFound: [], notInTrash: [] };
  for (const id of unique) {
    const d = byId.get(id);
    if (!d) plan.notFound.push(id);
    else if (d.is_trash === true) plan.deletable.push({ id, name: String(d.filename || "") });
    else plan.notInTrash.push({ id, name: String(d.filename || "") });
  }
  return plan;
}

export function describePlanRefusal(plan: DeletePlan): string | null {
  if (plan.notInTrash.length) {
    return `Refusing: ${plan.notInTrash.map((f) => `${f.id} ("${f.name}")`).join(", ")} ${plan.notInTrash.length === 1 ? "is" : "are"} not in the trash. Run \`plaud files trash <id>\` first; nothing was deleted.`;
  }
  if (plan.notFound.length) {
    return `Refusing: no recording found for ${plan.notFound.join(", ")}; nothing was deleted.`;
  }
  return null;
}
