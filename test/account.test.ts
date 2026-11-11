import test from "node:test";
import assert from "node:assert/strict";
import { formatHours, summarizeFileStats, summarizeQuota } from "../src/account.js";

test("file stats keep millisecond totals and convert the per-day averages from seconds", () => {
  const s = summarizeFileStats({ data_stat: { total_files: 2, total_duration: 3_600_000, recent_30_days_daily_avg: 60, max_files: 1 } });
  assert.equal(s.totalFiles, 2);
  assert.equal(s.totalDurationMs, 3_600_000);
  assert.equal(s.recent30DaysDailyAvgMs, 60_000);
  assert.equal(s.previous30DaysDailyAvgMs, null);
  assert.deepEqual(s.busiestDay, { files: 1, durationMs: 0 });
  assert.equal(s.daily, undefined);
  assert.throws(() => summarizeFileStats({}), /no file statistics/);
  assert.deepEqual(summarizeFileStats({ data_stat: { group_result: [{ day: "d", count: 1, duration: 5 }] } }, { daily: true }).daily, [{ day: "d", files: 1, durationMs: 5 }]);
});

test("quota handles paid, starter and wrapped responses", () => {
  assert.deepEqual(summarizeQuota({ is_starter: false }), { isStarter: false, canNotify: null, quota: null });
  assert.deepEqual(summarizeQuota({ data: { is_starter: true, can_notify: false, quota: { files: 3 } } }), { isStarter: true, canNotify: false, quota: { files: 3 } });
  assert.throws(() => summarizeQuota(null), /no quota/);
  assert.equal(formatHours(5_400_000), "1.5 h");
});
