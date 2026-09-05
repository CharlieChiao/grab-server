# 场地适配器接入契约 (Venue Deploy Contract)

本文档定义 grab-server 与球场适配器之间的契约。新球场接入只需实现适配器目录, 服务层(调度/重试/风控/待支付/兜底/任务组/通知)零改动复用。

## 架构总览

```
服务层(通用, 不含任何场地细节)
  scheduler / paymentLifecycle / payCodes / jobGroups / delegations / notifications
      │ 只认语义, 不认数字/域名/报文
      ▼
适配器契约(venueRegistry 自动发现 src/venues/*/)
      │
      ▼
场地适配器(每场地一个目录, 隔离所有场地私有逻辑)
  venues/<id>/venue.yml   声明式配置
  venues/<id>/index.js    适配器实现
```

## 服务层提供的能力(新场地免费获得)

| 能力 | 说明 | 位置 |
|---|---|---|
| 定时抢订 | 放场时刻推算、毫秒级精发、串行限流、风控冷却、线性重试 | `src/core/scheduler.js` |
| 待支付生命周期 | 人工支付窗口(15min)、1s 释放轮询、超时判定、实际等待时长展示 | `src/core/paymentLifecycle.js` |
| 两层余额兜底 | 授权方余额优先, 不足时创建者本人余额兜底(按用户凭证隔离限流) | `src/core/paymentLifecycle.js` |
| 任务组 | 多任务聚合、每周重复、成功策略 | `src/core/jobGroups.js` |
| 委托授权 | 支付方式白名单、时效、撤销 | `src/core/delegations.js` |
| 通知 | 微信订阅消息(结果+等待时长) | `src/core/notifications.js` |
| API | 抢订/任务/历史/支付确认/凭证/场次查询 | `src/api/` |

## 适配器接口契约

### 必须实现

| 接口 | 签名 | 说明 |
|---|---|---|
| `meta` | `{ id, name, logo?, desc? }` | 场地元信息, id 即目录名 |
| `ready(cred)` | `→ { ok, detail }` | 凭证有效性校验(服务端每小时/抢订前/提交前调用) |
| `grab(target, cred)` | `→ result` | 下单。成功: `{ success: true, orderId, message }`; 需人工支付(如微信)额外带 `requiresManualPayment: true`; 失败: `{ success: false, message }`, message 应保留上游文案(供风控分类) |

### 可选实现

| 接口 | 签名 | 说明 |
|---|---|---|
| `listSlots(query, cred)` | `→ [{ uid, court, begin, canAppoint }]` | 场次查询。slot 必须归一化为该形状(uid=场地唯一标识, begin=开始时间, canAppoint=可约布尔), 供待支付释放轮询复用 |
| `payments` | `{ wechat: <code>, balance: <code> }` | 本场支付码语义声明。服务层经 `payCodes.paymentKind(venueId, code)` 解析, 授权校验/通知/兜底均依赖; 未声明时兜底下单码回退 40 |
| `classifyGrabResult(result)` | `→ success/rate-limited/not-released/release-pending/transient/terminal` | 风控分类, 未实现则用通用关键词分类 |
| `riskProfile` | `{ scopeKey, booking: { minIntervalMs, jitterMs, ... } }` | 限流与重试节奏配置 |
| `preheat(cred)` / `buildGrabRequest(target, cred)` + `fireGrab(prebuilt)` | — | 抢首发性能优化(连接预热/请求预构建) |

### venue.yml 声明式配置(参考 venues/picklepop)

```yaml
id / name / logo / desc
backend:            # 场地私有后端参数(适配器自取)
  base / storeId / projectUid
  payMethodBalance / payMethodWechat   # 与 payments 声明对应
advanceDays:        # 类型→提前放场天数
release:            # 放场规则(时区/模式/时刻)
bookingHours:       # 营业时段与 slot 粒度
releaseRetry:       # 放场重试策略(间隔/校准数据)
courts:             # 场地清单(name/type/uid)
credentialSchema:   # 凭证字段说明(label/desc 供前端展示)
capture:            # CourtCapture 抓包配置
  hosts / paths / headers / discoveryPaths / tasks
```

## 支付码语义化(payCodes)

支付码数字是场地私有的(银豹 40=余额/900=微信, 其他场地可能完全不同)。**服务层禁止出现裸数字**, 一律经 `paymentKind(venueId, code)` 转换为 `balance` / `wechat` 语义。授权白名单、任务组校验、通知文案、API 展示均已走该入口。

## 待支付生命周期(依赖 `requiresManualPayment` 标志)

```
grab 成功 + requiresManualPayment + 委托任务
  → awaiting_payment (paymentExpiresAt = now + 15min)
      ├─ 授权方完成支付(confirm 接口) → done
      ├─ 释放轮询(1s, listSlots 归一化 slot)检测到可约 → 兜底/失败
      └─ 15min 超时 → 兜底/失败
兜底(两层, 按用户凭证隔离限流):
  第一层 授权方(B)余额 → 第二层 创建者(A)本人余额 → 失败归档
```

## 新球场发现流程(CourtCapture)

### 实时监听模式(已有)
1. `POST /api/venue-discovery/sessions` 创建会话
2. 客户端 mitmproxy 代理收集 HTTPS/JSON 流量(黑名单域名/支付内容丢弃)
3. 用户在候选列表锚定入口请求 → `POST /:id/lock-entry` 锁定服务 origin
4. 四阶段引导(账户验证→场地→场次→下单)逐阶段上传事件
5. `POST /:id/finalize` 生成草稿 manifest(存 `venue_discovery_drafts` 表)

### HAR 导入模式
1. 选择 HAR 文件(Quantumult X / Charles / Chrome 导出)
2. 解析全部条目, 按 origin 汇总候选(名称匹配+请求数启发式排序)
3. 用户锚定一条请求作为该球场服务的过滤入口(提取 origin)
4. 同 origin 条目按关键词规则自动分阶段(account/courts/slots/booking)回放上传
5. finalize 生成草稿, 流程与实时模式一致

### 草稿 manifest 与人工接入的差距
草稿含: 每阶段得分最高的 API 骨架(method/path/header名/请求响应类型骨架/slot时长统计)。
**不含**(需人工补充): 凭证真实值(加密库保管)、请求样本值、支付方式码(支付内容全链路丢弃)、slot 字段映射、venue.yml 运营参数(放场规则/限流/营业时段)。
草稿是写适配器的起点清单, 距离可运行适配器仍需人工实现 + self-test(未实现)。

## 新场地接入步骤清单

1. 用 CourtCapture 抓包(实时或 HAR 模式)获得 discovery 草稿
2. 参考 `venues/picklepop/` 新建 `venues/<id>/venue.yml` + `index.js`
3. 实现必须接口(meta/ready/grab), 按 `capture` 配置补凭证抓取规则
4. 声明 `payments` 支付码; 若支持微信支付, grab 结果带 `requiresManualPayment`
5. 配置 `riskProfile` 限流(下单接口实测风控阈值, 参考 releaseRetry 校准)
6. 测试: `npm test`; 真实凭证 ready 校验; 小额下单验证
