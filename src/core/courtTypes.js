/**
 * 场地类型注册表(唯一定义处): 类型 key → 中文标签。
 * 各球场 venue.yml 的 courts[].type 使用这些 key; 加载时经 normalizeCourtType 归一
 * (支持中文/常见别名, 拼写不一致自动收拢), 未知类型保留原值并告警。
 * 前端类型选项由 scavenge API 下发(带标签), 不在前端重复维护。
 */
export const COURT_TYPES = {
  tennis: "网球",
  pickle: "匹克球",
  badminton: "羽毛球",
  basketball: "篮球",
  football: "足球",
  table_tennis: "乒乓球",
  snooker: "台球",
  swimming: "游泳",
};

const ALIASES = {
  // 大小写/空格变体
  "tennis": "tennis", "网球场": "tennis", "网球": "tennis",
  "pickle": "pickle", "pickleball": "pickle", "匹克球": "pickle",
  "badminton": "badminton", "羽毛球": "badminton",
  "basketball": "basketball", "篮球": "basketball",
  "football": "football", "soccer": "football", "足球": "football",
  "table_tennis": "table_tennis", "tabletennis": "table_tennis", "乒乓": "table_tennis", "乒乓球": "table_tennis",
  "snooker": "snooker", "billiards": "snooker", "台球": "snooker",
  "swimming": "swimming", "游泳": "swimming",
};

// 归一: 小写去空格 → 查别名表; 命中返回标准 key, 未命中返回原值(隔离为独立类型, 加载时告警)
export function normalizeCourtType(raw) {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  return ALIASES[key] || String(raw).trim();
}

export function courtTypeLabel(type) {
  if (!type) return "";
  return COURT_TYPES[type] || type;
}
