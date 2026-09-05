import { getVenue } from "./venueRegistry.js";

// 支付码 → 语义(balance=可脚本闭环余额 / wechat=需人工支付): 各场地支付码不同, 以 venue 适配器的 payments 声明为准
export function paymentKind(venueId, code) {
  const payments = getVenue(venueId)?.payments;
  if (!payments) return null;
  for (const [kind, value] of Object.entries(payments)) {
    if (Number(value) === Number(code)) return kind;
  }
  return null;
}
