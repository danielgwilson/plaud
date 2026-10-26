// Pure planning logic for `plaud files speakers apply` (no HTTP, no filesystem).

export class SpeakerApplyInputError extends Error {}

export type SegmentAssignment = {
  segment_uid?: string;
  start_time?: number;
  end_time?: number;
  speaker: string;
};

export type SpeakerApplyPlan = {
  transResult: any[];
  aiContent: unknown;
  changed: number;
  alreadyApplied: number;
  skippedRenamed: number;
  unmatchedLabels: string[];
  unmatchedSegments: number;
  summaryReplacements: number;
  totalSegments: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanName(value: unknown, where: string): string {
  if (typeof value !== "string") throw new SpeakerApplyInputError(`${where} must be a string.`);
  const name = value.trim();
  if (!name) throw new SpeakerApplyInputError(`${where} must not be empty.`);
  return name;
}

export function parseSpeakerMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    throw new SpeakerApplyInputError('--map must be a JSON object, e.g. {"Speaker 1":"Person A"}.');
  }
  const out: Record<string, string> = {};
  for (const [label, name] of Object.entries(value)) {
    if (!label.trim()) throw new SpeakerApplyInputError("--map labels must not be empty.");
    out[label] = cleanName(name, `--map name for "${label}"`);
  }
  return out;
}

export function parseSummaryMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    throw new SpeakerApplyInputError('--summary-map must be a JSON object, e.g. {"Pat Lee":"Speaker 2"}.');
  }
  const out: Record<string, string> = {};
  for (const [text, name] of Object.entries(value)) {
    if (!text.trim()) throw new SpeakerApplyInputError("--summary-map keys must not be empty.");
    out[text] = cleanName(name, `--summary-map replacement for "${text}"`);
  }
  return out;
}

export function parseSegmentAssignments(value: unknown): SegmentAssignment[] {
  if (!Array.isArray(value)) {
    throw new SpeakerApplyInputError("--segments must be a JSON array of segment assignments.");
  }
  const out: SegmentAssignment[] = [];
  value.forEach((entry, i) => {
    const where = `--segments[${i}]`;
    if (!isObject(entry)) throw new SpeakerApplyInputError(`${where} must be an object.`);
    const speaker = cleanName(entry.speaker, `${where}.speaker`);
    const uid = entry.segment_uid;
    if (uid !== undefined && (typeof uid !== "string" || !uid)) {
      throw new SpeakerApplyInputError(`${where}.segment_uid must be a non-empty string.`);
    }
    if (typeof uid === "string") {
      out.push({ segment_uid: uid, speaker });
      return;
    }
    const { start_time: start, end_time: end } = entry;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SpeakerApplyInputError(`${where} needs segment_uid, or numeric start_time and end_time (ms).`);
    }
    out.push({ start_time: start, end_time: end, speaker });
  });
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function isJsonText(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Whole-token, single-pass replacement so swaps ("Speaker 1" <-> "Speaker 2") cannot chain and
// "Speaker 1" never matches inside "Speaker 10". Label whitespace may be any run of spaces/tabs,
// but not a newline (a trailing "Speaker" before a "1." list item must not match).
function replaceLabels(text: string, replacements: Map<string, string>): { text: string; count: number } {
  const labels = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const alternation = labels.map((l) => l.split(" ").map(escapeRegExp).join("[^\\S\\r\\n]+")).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, "g");
  // A JSON-string summary must stay parseable, so names are escaped for a JSON string context.
  const asJson = isJsonText(text);
  let count = 0;
  const out = text.replace(re, (m) => {
    const name = replacements.get(normalizeLabel(m));
    if (name === undefined) return m;
    count++;
    return asJson ? JSON.stringify(name).slice(1, -1) : name;
  });
  return { text: out, count };
}

export function planSpeakerApply({
  transResult,
  aiContent,
  map = {},
  segments = [],
  summaryMap = {},
  overwrite = false,
  summary = true,
}: {
  transResult: any[];
  aiContent?: unknown;
  map?: Record<string, string>;
  segments?: SegmentAssignment[];
  summaryMap?: Record<string, string>;
  overwrite?: boolean;
  summary?: boolean;
}): SpeakerApplyPlan {
  const labelMap = new Map(Object.entries(map));
  const explicit = Object.entries(summaryMap);
  if (labelMap.size === 0 && segments.length === 0 && explicit.length === 0) {
    throw new SpeakerApplyInputError("Provide at least one --map entry, --segments assignment, or --summary-map entry.");
  }
  if (!summary && explicit.length > 0) {
    throw new SpeakerApplyInputError("--summary-map cannot be combined with --no-summary.");
  }

  // Per-segment assignments win over --map. Entries with a segment_uid match by uid only.
  const byUid = new Map<string, string>();
  const byTime = new Map<string, string>();
  for (const a of segments) {
    const bucket = a.segment_uid !== undefined ? byUid : byTime;
    const key = a.segment_uid !== undefined ? a.segment_uid : `${a.start_time}:${a.end_time}`;
    const prev = bucket.get(key);
    if (prev !== undefined && prev !== a.speaker) {
      throw new SpeakerApplyInputError(`--segments has conflicting names for segment ${key}.`);
    }
    bucket.set(key, a.speaker);
  }

  const originals = new Set<string>();
  const matchedUids = new Set<string>();
  const matchedTimes = new Set<string>();
  let changed = 0;
  let alreadyApplied = 0;
  let skippedRenamed = 0;

  const updated = transResult.map((seg: any) => {
    if (!seg || typeof seg !== "object") return seg;
    const speaker = typeof seg.speaker === "string" ? seg.speaker : "";
    const original = typeof seg.original_speaker === "string" ? seg.original_speaker : null;
    if (original !== null) originals.add(original);

    let target: string | undefined;
    const uid = typeof seg.segment_uid === "string" ? seg.segment_uid : "";
    const timeKey = `${seg.start_time}:${seg.end_time}`;
    if (uid && byUid.has(uid)) {
      target = byUid.get(uid);
      matchedUids.add(uid);
    } else if (byTime.has(timeKey)) {
      target = byTime.get(timeKey);
      matchedTimes.add(timeKey);
    } else if (original !== null) {
      target = labelMap.get(original);
    }
    if (target === undefined) return seg;

    if (target === speaker) {
      alreadyApplied++;
      return seg;
    }
    // Generic = nobody has named this segment yet. A segment with no original_speaker and a
    // non-empty speaker has unknown provenance, so the guard treats it as human-named.
    const generic = speaker === "" || (original !== null && speaker === original);
    if (!overwrite && !generic) {
      skippedRenamed++;
      return seg;
    }
    changed++;
    return { ...seg, speaker: target };
  });

  const unmatchedLabels = [...labelMap.keys()].filter((label) => !originals.has(label));
  const unmatchedSegments = byUid.size - matchedUids.size + (byTime.size - matchedTimes.size);

  let aiOut = aiContent;
  let summaryReplacements = 0;
  if (summary && typeof aiContent === "string" && aiContent) {
    // A label is only safe to rewrite in the summary when every segment that came from it now
    // carries the same new name; a split or partially skipped label is left alone.
    const namesByOriginal = new Map<string, Set<string>>();
    for (const seg of updated) {
      if (!seg || typeof seg !== "object" || typeof seg.original_speaker !== "string") continue;
      const names = namesByOriginal.get(seg.original_speaker) ?? new Set<string>();
      names.add(typeof seg.speaker === "string" ? seg.speaker : "");
      namesByOriginal.set(seg.original_speaker, names);
    }
    const replacements = new Map<string, string>();
    for (const [label, name] of labelMap) {
      const names = namesByOriginal.get(label);
      const key = normalizeLabel(label);
      if (names && names.size === 1 && names.has(name) && key !== name) replacements.set(key, name);
    }
    // Explicit summary text (a name typed earlier, or a first name) is replaced as given and wins
    // over a derived label replacement for the same text.
    for (const [text, name] of explicit) {
      const key = normalizeLabel(text);
      if (key !== name) replacements.set(key, name);
    }
    if (replacements.size > 0) {
      const res = replaceLabels(aiContent, replacements);
      aiOut = res.text;
      summaryReplacements = res.count;
    }
  }

  return {
    transResult: updated,
    aiContent: aiOut,
    changed,
    alreadyApplied,
    skippedRenamed,
    unmatchedLabels,
    unmatchedSegments,
    summaryReplacements,
    totalSegments: transResult.length,
  };
}
