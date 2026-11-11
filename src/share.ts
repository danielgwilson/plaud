// Sharing a recording, as in the Plaud web app's Share dialog.
//   private: the recipients you name get an email from Plaud with a link only they can open.
//   public:  anyone who has the link can open it, optionally until an expiry time.
// Both publish content to other people, so the CLI makes you choose the mode and the content explicitly.

export class ShareInputError extends Error {}

export const OBJECT_TYPE = "file";
export const NOT_FOUND_STATUS = 40400;
export const SUMMARY_NOTE_TYPE = "auto_sum_note";

export type ContentConfig = { audio: boolean; transcript: boolean; highlights: 0; overview: boolean; notes: string[] };

const CONTENT_WORDS = ["audio", "transcript", "summary", "overview"] as const;

export type Note = { data_id: string; data_type: string };

/** `--content` words plus `--note` ids become the API's content_config. Nothing is shared by default. */
export function buildContentConfig({
  content,
  noteIds = [],
  notes = [],
}: {
  content: string[];
  noteIds?: string[];
  notes?: Note[];
}): ContentConfig {
  const words = content.flatMap((c) => String(c).split(",")).map((w) => w.trim().toLowerCase()).filter(Boolean);
  for (const w of words) {
    if (!(CONTENT_WORDS as readonly string[]).includes(w)) {
      throw new ShareInputError(`Unknown --content "${w}". Choose from: ${CONTENT_WORDS.join(", ")}.`);
    }
  }
  const config: ContentConfig = {
    audio: words.includes("audio"),
    transcript: words.includes("transcript"),
    highlights: 0,
    overview: words.includes("overview"),
    notes: [],
  };
  if (words.includes("summary")) {
    const summary = notes.find((n) => n.data_type === SUMMARY_NOTE_TYPE);
    if (!summary) throw new ShareInputError("This recording has no summary to share yet.");
    config.notes.push(String(summary.data_id));
  }
  for (const id of noteIds.flatMap((n) => String(n).split(",")).map((n) => n.trim()).filter(Boolean)) {
    if (!notes.some((n) => String(n.data_id) === id)) throw new ShareInputError(`No note "${id}" on this recording (see \`plaud files notes list\`).`);
    if (!config.notes.includes(id)) config.notes.push(id);
  }
  if (!config.audio && !config.transcript && !config.overview && config.notes.length === 0) {
    throw new ShareInputError(`Choose what to share with --content (${CONTENT_WORDS.join(", ")}) and/or --note <noteId>. Nothing is shared by default.`);
  }
  return config;
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function parseRecipients(values: string[]): string[] {
  const emails = values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  if (emails.length === 0) throw new ShareInputError("Name at least one recipient with --to <email>.");
  for (const e of emails) if (!EMAIL.test(e)) throw new ShareInputError(`"${e}" is not an email address.`);
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

/** Plaud wants RFC3339 ("2026-12-31T23:59:59Z"). A bare date means the end of that day, UTC. */
export function parseExpiry(value: string, now = Date.now()): string {
  const raw = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const ms = Date.parse(dateOnly ? `${raw}T23:59:59Z` : raw);
  if (!Number.isFinite(ms)) throw new ShareInputError(`--expire "${value}" is not a date. Use 2026-12-31 or 2026-12-31T17:00:00Z.`);
  if (ms <= now) throw new ShareInputError("--expire is in the past.");
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type ShareMode = { mode: "private"; recipients: string[] } | { mode: "public" };

/** Private is the default. Public needs --public; the two cannot be mixed; --yes confirms either. */
export function chooseMode({ to, isPublic, yes }: { to: string[]; isPublic: boolean; yes: boolean }): ShareMode {
  if (isPublic && to.length > 0) throw new ShareInputError("Use either --public or --to, not both.");
  if (!isPublic && to.length === 0) {
    throw new ShareInputError("Choose who to share with: --to <email> (private; Plaud emails them a link) or --public (anyone with the link).");
  }
  return isPublic ? { mode: "public" } : { mode: "private", recipients: parseRecipients(to) };
}

export function describeConsequence(mode: ShareMode, config: ContentConfig): string {
  const what = [config.audio && "the audio", config.transcript && "the transcript", config.overview && "the overview", config.notes.length > 0 && `${config.notes.length} note(s)/summary`].filter(Boolean).join(", ");
  return mode.mode === "public"
    ? `This creates a PUBLIC link: anyone who gets the URL can open ${what}.`
    : `This makes Plaud EMAIL ${mode.recipients.join(", ")} a link to ${what}.`;
}

export function buildPublicCreateBody(fileId: string, config: ContentConfig) {
  return { object_id: fileId, object_type: OBJECT_TYPE, content_config: config };
}

export function buildPrivateCreateBody(fileId: string, config: ContentConfig, emails: string[]) {
  return { object_id: fileId, object_type: OBJECT_TYPE, content_config: config, recipients: emails.map((contact) => ({ contact_type: "email", contact })) };
}

export function summarizePublic(data: any): { url: string; shareKey: string; expireAt: string | null; content: unknown; createdAt: string | null } | null {
  if (!data || typeof data !== "object" || !data.share_url) return null;
  return { url: String(data.share_url), shareKey: String(data.share_key ?? ""), expireAt: data.expire_at ?? null, content: data.content_config ?? null, createdAt: data.created_at ?? null };
}

export function summarizePrivate(data: any): { recipients: Array<Record<string, unknown>> } | null {
  if (!data || typeof data !== "object") return null;
  const list = Array.isArray(data.recipients) ? data.recipients : [];
  return { recipients: list.map((r: any) => ({ recipientId: r?.recipient_id ?? null, contact: r?.contact ?? null, status: r?.status ?? null })) };
}
