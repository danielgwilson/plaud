// Folders ("tags" in this CLI's older naming) from the Plaud web app: create, rename, recolor, delete.
// A file sits in at most one folder; `files tags add` moves files into one.

export class FolderInputError extends Error {}

export const DEFAULT_FOLDER_ICON = "e674";
export const DEFAULT_FOLDER_COLOR = "#c149eb";

export type Folder = { id: string; name: string; icon?: string; color?: string };

export function normalizeColor(value: string): string {
  const v = String(value ?? "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new FolderInputError(`--color must look like #c149eb, got "${value}".`);
  return v.toLowerCase();
}

export function normalizeName(value: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new FolderInputError("The folder name is empty.");
  return v;
}

export function buildCreateBody(name: string, icon?: string, color?: string): { name: string; icon: string; color: string } {
  return {
    name: normalizeName(name),
    icon: icon !== undefined ? String(icon).trim() || DEFAULT_FOLDER_ICON : DEFAULT_FOLDER_ICON,
    color: color !== undefined ? normalizeColor(color) : DEFAULT_FOLDER_COLOR,
  };
}

/** The API wants the whole {name, icon, color}; fill what the caller did not change from the current folder. */
export function buildUpdateBody(current: Folder, changes: { name?: string; icon?: string; color?: string }): { name: string; icon: string; color: string } {
  if (changes.name === undefined && changes.icon === undefined && changes.color === undefined) {
    throw new FolderInputError("Nothing to change: pass --name, --icon and/or --color.");
  }
  return {
    name: changes.name !== undefined ? normalizeName(changes.name) : current.name,
    icon: changes.icon !== undefined ? String(changes.icon).trim() || (current.icon ?? DEFAULT_FOLDER_ICON) : current.icon ?? DEFAULT_FOLDER_ICON,
    color: changes.color !== undefined ? normalizeColor(changes.color) : current.color ?? DEFAULT_FOLDER_COLOR,
  };
}

export function findFolder(folders: Folder[], idOrName: string): Folder {
  const wanted = String(idOrName).trim();
  const byId = folders.find((f) => f.id === wanted);
  if (byId) return byId;
  const byName = folders.filter((f) => f.name.trim().toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new FolderInputError(`More than one folder is named "${wanted}". Use its id.`);
  throw new FolderInputError(`No folder "${wanted}". Run \`plaud files tags list\`.`);
}
