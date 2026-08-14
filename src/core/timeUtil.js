/** Release-time calculation for calendar-day batch releases in China. */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseDate(dateStr) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr).trim());
  if (!match) throw new Error(`非法日期格式: ${dateStr} (需要 YYYY-MM-DD)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseTime(timeStr = "00:00:00.000") {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(timeStr).trim());
  if (!match) throw new Error(`非法放场时刻: ${timeStr}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0), Number(String(match[4] || "0").padEnd(3, "0"))];
}

export function computeReleaseTimeUTC(dateStr, calendarDaysBefore = 0, at = "00:00:00.000") {
  const [year, month, day] = parseDate(dateStr);
  const [hour, minute, second, millisecond] = parseTime(at);
  const releaseMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
    - CN_OFFSET_MS
    - Number(calendarDaysBefore) * 24 * 60 * 60 * 1000;
  return new Date(releaseMs);
}

function targetCourtKeys(target) {
  if (Array.isArray(target.courts) && target.courts.length) {
    return target.courts.map((court) => typeof court === "string" ? court : (court.courtUid || court.court)).filter(Boolean);
  }
  return [target.courtUid || target.court].filter(Boolean);
}

function ruleForCourt(venueMeta, courtMeta) {
  const release = venueMeta.release || {};
  const rules = release.rules || {};
  if (courtMeta && rules[courtMeta.type]) return rules[courtMeta.type];
  if (release.default) return release.default;
  const days = courtMeta && venueMeta.advanceDays && venueMeta.advanceDays[courtMeta.type] != null
    ? venueMeta.advanceDays[courtMeta.type]
    : Math.min(...Object.values(venueMeta.advanceDays || {}).filter((value) => typeof value === "number"), 0);
  return { calendarDaysBefore: days, at: "00:00:00.000" };
}

export function autoFireAt(venueMeta, target) {
  if (!venueMeta || !target || !target.date) return null;
  const courts = venueMeta.courts || [];
  const keys = targetCourtKeys(target);
  const releaseTimes = keys.map((key) => {
    const court = courts.find((item) => String(item.uid) === String(key) || item.name === key || item.id === key);
    const rule = ruleForCourt(venueMeta, court);
    return computeReleaseTimeUTC(target.date, rule.calendarDaysBefore || 0, rule.at || "00:00:00.000").getTime();
  });
  if (!releaseTimes.length) {
    const rule = ruleForCourt(venueMeta, null);
    releaseTimes.push(computeReleaseTimeUTC(target.date, rule.calendarDaysBefore || 0, rule.at || "00:00:00.000").getTime());
  }
  // A combined task can run only after every selected court has released.
  return new Date(Math.max(...releaseTimes)).toISOString();
}