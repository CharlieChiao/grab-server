/**
 * 时间/开抢时刻计算工具
 *
 * 放场规则: 场地按 advanceDays[type] 提前放场。
 *   放场日 = 预订日 - advanceDays 天
 *   放场时刻 = 放场日 当天 00:00:00.000 (北京时间, 东八区)
 *   开抢(fireAt) = 该北京时刻对应的 UTC 时间
 *
 * 例: 抢 8/15 的网球(tennis, advanceDays=3)
 *   放场日 = 8/15 - 3 = 8/12
 *   放场时刻 = 8/12 00:00:00 (北京时间)
 *   fireAt(UTC) = 8/11T16:00:00.000Z
 */

const CN_OFFSET_MS = 8 * 60 * 60 * 1000; // 东八区偏移

/**
 * 把 "YYYY-MM-DD" 视为北京时间当天 00:00:00, 减去 days 天, 返回该北京时刻对应的 UTC Date。
 * @param {string} dateStr 预订日期 "YYYY-MM-DD"
 * @param {number} advanceDays 提前放场天数
 * @returns {Date} 放场时刻(UTC)
 */
export function computeReleaseTimeUTC(dateStr, advanceDays = 0) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr).trim());
  if (!m) throw new Error(`非法日期格式: ${dateStr} (需 YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  // 预订日 北京时间 00:00:00 的 UTC 毫秒 = Date.UTC(北京当天) - 8h
  const bookingBjMidnightUTC = Date.UTC(y, mon - 1, d) - CN_OFFSET_MS;
  // 放场日 = 预订日 - advanceDays 天
  const releaseUTCms = bookingBjMidnightUTC - advanceDays * 24 * 60 * 60 * 1000;
  return new Date(releaseUTCms);
}

/**
 * 根据球场 meta + target 自动推导 fireAt(开抢时刻, UTC ISO)。
 *
 * 支持 target 两种形态:
 *   - 单场地: { court, date }
 *   - 多场地: { date, courts:[name|{court:name}, ...] }
 * 多场地时: 取所有选中场地中 **最小的 advanceDays** (即放场最晚者), 保证到点时全部已放场。
 * 找不到对应 type 时: 回退到 advanceDays 的最小值(仍保证到点已放场), 都没有取 0。
 *
 * @param {object} venueMeta  含 advanceDays 与 courts
 * @param {object} target     { court, date, ...} 或 { date, courts:[...] }
 * @returns {string|null}     ISO 字符串; 无法推导时返回 null
 */
export function autoFireAt(venueMeta, target) {
  if (!venueMeta || !target || !target.date) return null;
  const advanceDays = venueMeta.advanceDays || {};
  const courtsMeta = venueMeta.courts || [];

  // 收集本次要抢的场地名(数组)
  const wantNames = [];
  if (Array.isArray(target.courts) && target.courts.length > 0) {
    for (const c of target.courts) {
      wantNames.push(typeof c === "string" ? c : (c.courtUid || c.court));
    }
  } else if (target.courtUid || target.court) {
    wantNames.push(target.courtUid || target.court);
  }

  // 找每个场地的 advanceDays
  const daysList = [];
  for (const name of wantNames) {
    const cm = courtsMeta.find((c) => c.name === name || c.uid === name);
    const type = cm ? cm.type : null;
    if (type && advanceDays[type] != null) daysList.push(advanceDays[type]);
  }

  // 多场地取最小(放场最晚者); 找不到时回退 advanceDays 最小值; 再没有就 0
  let days;
  if (daysList.length > 0) {
    days = Math.min(...daysList);
  } else {
    const vals = Object.values(advanceDays).filter((v) => typeof v === "number");
    days = vals.length ? Math.min(...vals) : 0;
  }
  return computeReleaseTimeUTC(target.date, days).toISOString();
}
