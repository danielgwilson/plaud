// Edits to a single recording: title, transcript text, and summary/notes.
// Mirrors what the Plaud web app sends when you edit these in the file view.

export class EditInputError extends Error {}

export function buildRenameBody(title: string, fileVersion?: number): Record<string, unknown> {
  const filename = String(title ?? "").trim();
  if (!filename) throw new EditInputError("The title is empty.");
  const body: Record<string, unknown> = { filename, extra_data: { actionData: { hasTitleEdit: true } } };
  if (fileVersion !== undefined) body.file_version = fileVersion;
  return body;
}

export type Segment = { content?: string; [k: string]: unknown };

export type TranscriptEditPlan = { segments: Segment[]; changed: number; changes: Array<{ index: number; before: string; after: string }> };

/** Replace the text of one transcript segment (zero-based index). Speaker names and timings are kept. */
export function planSegmentEdit(segments: Segment[], index: number, text: string): TranscriptEditPlan {
  if (!Array.isArray(segments) || segments.length === 0) throw new EditInputError("This recording has no transcript segments.");
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
    throw new EditInputError(`Segment ${index} does not exist; this transcript has ${segments.length} segment(s) (0 to ${segments.length - 1}).`);
  }
  if (!String(text ?? "").trim()) throw new EditInputError("The new segment text is empty.");
  const before = String(segments[index].content ?? "");
  const next = segments.map((s, i) => (i === index ? { ...s, content: text } : s));
  return { segments: next, changed: before === text ? 0 : 1, changes: before === text ? [] : [{ index, before, after: text }] };
}

/** Literal find-and-replace across all segment text. */
export function planTranscriptReplace(segments: Segment[], find: string, replacement: string): TranscriptEditPlan {
  if (!Array.isArray(segments) || segments.length === 0) throw new EditInputError("This recording has no transcript segments.");
  if (!find) throw new EditInputError("--find is empty.");
  const changes: TranscriptEditPlan["changes"] = [];
  const next = segments.map((s, i) => {
    const before = String(s.content ?? "");
    if (!before.includes(find)) return s;
    const after = before.split(find).join(replacement);
    changes.push({ index: i, before, after });
    return { ...s, content: after };
  });
  return { segments: next, changed: changes.length, changes };
}

export type Note = { data_id: string; data_type: string; data_title?: string; data_tab_name?: string; data_content?: string; [k: string]: unknown };

export function findNote(notes: Note[], noteId: string): Note {
  const note = notes.find((n) => String(n?.data_id) === noteId);
  if (!note) {
    const ids = notes.map((n) => n.data_id).join(", ") || "none";
    throw new EditInputError(`No note "${noteId}" on this recording. Available: ${ids}.`);
  }
  return note;
}

export function buildNoteUpdateBody(fileId: string, note: Note, changes: { title?: string; content?: string }): Record<string, unknown> {
  if (changes.title === undefined && changes.content === undefined) throw new EditInputError("Nothing to change: pass --title and/or --content/--file.");
  if (changes.content !== undefined && !changes.content.trim()) throw new EditInputError("The new note content is empty. Use `notes delete` to remove a note.");
  return {
    file_id: fileId,
    note_id: note.data_id,
    note_type: note.data_type,
    note_title: changes.title ?? note.data_title ?? "",
    note_content: changes.content ?? note.data_content ?? "",
  };
}

export function buildNoteDeleteBody(note: Note): Record<string, unknown> {
  return { note_id: note.data_id, note_type: note.data_type, note_content: note.data_content ?? "" };
}
