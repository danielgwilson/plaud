// Account basics from the Plaud web app: file statistics and the transcription quota.

export type FileStats = {
  totalFiles: number;
  totalDays: number;
  totalDurationMs: number;
  totalTranscribedDurationMs: number;
  recent30DaysDailyAvgMs: number | null;
  previous30DaysDailyAvgMs: number | null;
  mostActiveHour: number | null;
  // Two separate records: the day with the most files is usually not the day with the most recorded time.
  maxFilesInOneDay: number | null;
  maxDurationMsInOneDay: number | null;
  daily?: Array<{ day: string; files: number; durationMs: number }>;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const secToMs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Normalizes GET /user/stat/file. All durations are returned in milliseconds, matching `files list`. */
export function summarizeFileStats(res: any, { daily = false }: { daily?: boolean } = {}): FileStats {
  const s = res?.data_stat;
  if (!s || typeof s !== "object") throw new Error("Plaud returned no file statistics.");
  if (numOrNull(s.total_files) === null && numOrNull(s.total_duration) === null) {
    throw new Error("Plaud's file statistics have no totals (the response format may have changed).");
  }
  const out: FileStats = {
    totalFiles: num(s.total_files),
    totalDays: num(s.total_days),
    totalDurationMs: num(s.total_duration),
    totalTranscribedDurationMs: num(s.total_transcribed_duration),
    // These two arrive in seconds per day (unlike the totals, which are milliseconds): 23,722 here matches ~6.6 h/day in the daily rows.
    recent30DaysDailyAvgMs: secToMs(s.recent_30_days_daily_avg),
    previous30DaysDailyAvgMs: secToMs(s.previous_30_days_daily_avg),
    mostActiveHour: numOrNull(s.most_active_hour),
    maxFilesInOneDay: numOrNull(s.max_files),
    maxDurationMsInOneDay: numOrNull(s.max_duration),
  };
  if (daily) {
    out.daily = (Array.isArray(s.group_result) ? s.group_result : []).map((d: any) => ({ day: String(d?.day ?? ""), files: num(d?.count), durationMs: num(d?.duration) }));
  }
  return out;
}

export type Quota = { isStarter: boolean; canNotify: boolean | null; quota: Record<string, unknown> | null };

/** Normalizes GET /user/stat/transcription/quota. Paid plans answer only `{ is_starter: false }`. */
export function summarizeQuota(res: any): Quota {
  const d = res?.data && typeof res.data === "object" ? res.data : res;
  if (!d || typeof d !== "object") throw new Error("Plaud returned no quota information.");
  return {
    isStarter: d.is_starter === true,
    canNotify: typeof d.can_notify === "boolean" ? d.can_notify : null,
    quota: d.quota && typeof d.quota === "object" ? (d.quota as Record<string, unknown>) : null,
  };
}

export function formatHours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
