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

// ASCII only on purpose: look-alike (non-ASCII) domains are refused rather than mailed.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function parseRecipients(values: string[]): string[] {
  const emails = values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  if (emails.length === 0) throw new ShareInputError("Name at least one recipient with --to <email>.");
  for (const e of emails) if (!EMAIL.test(e)) throw new ShareInputError(`"${e}" is not an email address.`);
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

/**
 * Plaud wants RFC3339 ("2026-12-31T23:59:59Z"). Accepted here: a date (YYYY-MM-DD, meaning the end of that day in
 * UTC) or a date-time with an explicit Z or offset. Anything ambiguous (no zone, "12/31/2026", "2027") is refused.
 */
export function parseExpiry(value: string, now = Date.now()): string {
  const raw = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.exec(raw);
  const m = dateOnly ?? dateTime;
  if (!m) throw new ShareInputError(`--expire "${value}" is not accepted. Use 2026-12-31 (end of that day, UTC) or 2026-12-31T17:00:00Z (with Z or an offset like -08:00).`);
  const ms = Date.parse(dateOnly ? `${raw}T23:59:59Z` : raw);
  if (!Number.isFinite(ms)) throw new ShareInputError(`--expire "${value}" is not a real date.`);
  const [, y, mo, d] = m;
  if (dateOnly) {
    const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) {
      throw new ShareInputError(`--expire "${value}" is not a real date.`);
    }
  }
  if (ms <= now) throw new ShareInputError("--expire is in the past.");
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type ShareMode = { mode: "private"; recipients: string[] } | { mode: "public" };

/** You must pick a mode. Private needs --to; public needs the explicit --public; the two cannot be mixed. */
export function chooseMode({ to, isPublic }: { to: string[]; isPublic: boolean }): ShareMode {
  if (isPublic && to.length > 0) throw new ShareInputError("Use either --public or --to, not both.");
  if (!isPublic && to.length === 0) {
    throw new ShareInputError("Choose who to share with: --to <email> (private; Plaud emails them a link) or --public (anyone with the link).");
  }
  return isPublic ? { mode: "public" } : { mode: "private", recipients: parseRecipients(to) };
}

export function describeConsequence(mode: ShareMode, config: ContentConfig, expireAt: string | null = null): string {
  const what = [config.audio && "the audio", config.transcript && "the transcript", config.overview && "the overview", config.notes.length > 0 && `${config.notes.length} note(s)/summary`].filter(Boolean).join(", ");
  return mode.mode === "public"
    ? `This creates a PUBLIC link: anyone who gets the URL can open ${what}, ${expireAt ? `until ${expireAt}` : "with no expiry until you run `plaud files share revoke <id>`"}.`
    : `This makes Plaud EMAIL ${mode.recipients.join(", ")} a link to ${what}, and it stays open until you remove each recipient.`;
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

export type PrivateSummary = { recipients: Array<{ recipientId: string | null; contact: string | null; status: string | null }> } | { unrecognized: true; keys: string[] };

/** An answer without a recipients list is reported as unrecognized, never as "shared with nobody". */
export function summarizePrivate(data: any): PrivateSummary | null {
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.recipients)) return { unrecognized: true, keys: Object.keys(data) };
  return { recipients: data.recipients.map((r: any) => ({ recipientId: r?.recipient_id ?? null, contact: r?.contact ?? null, status: r?.status ?? null })) };
}

// ---- Create flow (injected api so it can be tested without a network) ----

export type ShareApi = {
  getPublic: () => Promise<any | null>;
  createPublic: (body: unknown) => Promise<any>;
  setExpiry: (expireAt: string) => Promise<any>;
  deletePublic: () => Promise<unknown>;
  createPrivate: (body: unknown) => Promise<any>;
};

/** Raised when a request may or may not have gone through. Never invites a blind retry. */
export class ShareUncertainError extends Error {
  stillShared: boolean | null;
  constructor(message: string, stillShared: boolean | null = null) {
    super(message);
    this.name = "ShareUncertainError";
    this.stillShared = stillShared;
  }
}

/** Remove the public link and check it is really gone. Returns whether it is. */
export async function removePublicAndVerify(api: Pick<ShareApi, "getPublic" | "deletePublic">): Promise<boolean | null> {
  try {
    await api.deletePublic();
  } catch {
    /* settled by the read-back below */
  }
  try {
    return (await api.getPublic()) === null;
  } catch {
    return null;
  }
}

export async function createPublicShareFlow(api: ShareApi, fileId: string, config: ContentConfig, expireAt: string | null) {
  const existing = summarizePublic(await api.getPublic());
  if (existing) {
    throw new ShareInputError(
      `This recording already has a public link (${existing.expireAt ? `expires ${existing.expireAt}` : "no expiry"}, sharing ${JSON.stringify(existing.content)}). Run \`plaud files share revoke ${fileId}\` first if you want a new one.`,
    );
  }
  let created: any;
  try {
    created = await api.createPublic(buildPublicCreateBody(fileId, config));
  } catch (err: any) {
    // The link may exist even though the reply did not arrive.
    let link: any = null;
    let known = true;
    try {
      link = await api.getPublic();
    } catch {
      known = false;
    }
    if (link && expireAt) {
      const gone = await removePublicAndVerify(api);
      throw new ShareUncertainError(
        gone ? `Creating the link failed (${err?.message || err}) and the link that may have been made was removed.` : `Creating the link failed (${err?.message || err}) and a link may still be open: run \`plaud files share revoke ${fileId}\`.`,
        gone ? false : true,
      );
    }
    throw new ShareUncertainError(
      `Creating the link did not confirm (${err?.message || err}). ${link ? "A link exists" : known ? "No link was found" : "Whether a link exists is unknown"}: check \`plaud files share get ${fileId}\` before retrying.`,
      link ? true : known ? false : null,
    );
  }

  let current = summarizePublic(created);
  if (expireAt) {
    let ok = false;
    let why = "";
    try {
      await api.setExpiry(expireAt);
      current = summarizePublic(await api.getPublic()); // trust the server's state, not the reply
      ok = current?.expireAt === expireAt;
      if (!ok) why = `Plaud kept expiry ${current?.expireAt ?? "none"} instead of ${expireAt}`;
    } catch (err: any) {
      why = String(err?.message || err);
    }
    if (!ok) {
      // Fail closed: never leave a link open without the expiry that was asked for.
      const gone = await removePublicAndVerify(api);
      throw new ShareUncertainError(
        gone === true
          ? `Could not set the expiry (${why}); the public link was removed.`
          : `Could not set the expiry (${why}) and the public link could not be confirmed removed: run \`plaud files share revoke ${fileId}\` now.`,
        gone === true ? false : true,
      );
    }
  }
  if (!current) throw new ShareUncertainError(`Plaud did not return a public link; check \`plaud files share get ${fileId}\`.`);
  return { id: fileId, mode: "public" as const, url: current.url, expireAt: current.expireAt, content: current.content ?? config, note: `Anyone with this URL can open the shared content. Remove it with \`plaud files share revoke ${fileId}\`.` };
}

export async function createPrivateShareFlow(api: ShareApi, fileId: string, config: ContentConfig, recipients: string[]) {
  let data: any;
  try {
    data = await api.createPrivate(buildPrivateCreateBody(fileId, config, recipients));
  } catch (err: any) {
    throw new ShareUncertainError(`The private share did not confirm (${err?.message || err}). The emails may already have been sent: check \`plaud files share get ${fileId}\` before retrying.`);
  }
  return { id: fileId, mode: "private" as const, recipients, content: config, share: summarizePrivate(data) ?? data };
}
