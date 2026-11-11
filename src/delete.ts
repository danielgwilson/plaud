// Permanent deletion of recordings that are already in the trash (the web app's "Delete permanently").

export class DeleteInputError extends Error {}

export type DeletePlan = { deletable: Array<{ id: string; name: string }>; notFound: string[]; notInTrash: Array<{ id: string; name: string }> };

/** Sort the requested ids into: safe to delete (in trash), not found, and refused (still active). */
export function planPermanentDelete(ids: string[], details: any[]): DeletePlan {
  const unique = [...new Set(ids.map((i) => String(i).trim()).filter(Boolean))];
  if (unique.length === 0) throw new DeleteInputError("Pass at least one recording id.");
  const byId = new Map<string, any>();
  for (const d of Array.isArray(details) ? details : []) if (d?.id) byId.set(String(d.id), d);
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
