import test from "node:test";
import assert from "node:assert/strict";
import { formatHours, summarizeFileStats, summarizeQuota } from "../src/account.js";

test("file stats keep millisecond totals and convert the per-day averages from seconds", () => {
  const s = summarizeFileStats({ data_stat: { total_files: 2, total_duration: 3_600_000, recent_30_days_daily_avg: 60, max_files: 1 } });
  assert.equal(s.totalFiles, 2);
  assert.equal(s.totalDurationMs, 3_600_000);
  assert.equal(s.recent30DaysDailyAvgMs, 60_000);
  assert.equal(s.previous30DaysDailyAvgMs, null);
  assert.equal(s.maxFilesInOneDay, 1);
  assert.equal(s.maxDurationMsInOneDay, null);
  assert.equal(s.daily, undefined);
  assert.throws(() => summarizeFileStats({}), /no file statistics/);
  assert.throws(() => summarizeFileStats({ data_stat: { something_else: 1 } }), /no totals/);
  assert.deepEqual(summarizeFileStats({ data_stat: { total_files: 1, group_result: [{ day: "d", count: 1, duration: 5 }] } }, { daily: true }).daily, [{ day: "d", files: 1, durationMs: 5 }]);
});

test("quota handles paid, starter and wrapped responses", () => {
  assert.deepEqual(summarizeQuota({ is_starter: false }), { isStarter: false, canNotify: null, quota: null });
  assert.deepEqual(summarizeQuota({ data: { is_starter: true, can_notify: false, quota: { files: 3 } } }), { isStarter: true, canNotify: false, quota: { files: 3 } });
  assert.throws(() => summarizeQuota(null), /no quota/);
  assert.equal(formatHours(5_400_000), "1.5 h");
});

test("the per-day average unit is seconds: real-shaped figures agree with the daily rows", () => {
  // Shape taken from a real account: daily durations are milliseconds; the 30-day average was 23,722.
  const day = 23_722_000; // ms recorded on an average day
  const rows = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, count: 8, duration: day + (i % 2 ? 2_000_000 : -2_000_000) }));
  const s = summarizeFileStats({ data_stat: { total_files: 240, total_duration: day * 30, recent_30_days_daily_avg: 23_722, group_result: rows } }, { daily: true });
  const mean = s.daily!.reduce((a, d) => a + d.durationMs, 0) / s.daily!.length;
  assert.ok(Math.abs(s.recent30DaysDailyAvgMs! - mean) / mean < 0.05, "converted average is within 5% of the rows' mean");
});
