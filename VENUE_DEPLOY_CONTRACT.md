# 场地适配器接入契约 (Venue Deploy Contract)

本文档定义 grab-server 与球场适配器之间的契约, 覆盖服务端的服务、存储与使用。新球场接入只需实现适配器目录, 服务层零改动复用。CourtCapture 抓包与发现流程见 `COURTCAPTURE_GUIDE.md`。

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
| `meta` | `{ id, name, logo?, desc? }` | 场地元信息, id 即目录名; `meta.raw` 携带整个 venue.yml |
| `ready(cred)` | `→ { ok, detail }` | 凭证有效性校验(服务端每小时/抢订前/提交前调用) |
| `grab(target, cred)` | `→ result` | 下单。成功: `{ success: true, orderId, message }`; 需人工支付(如微信)额外带 `requiresManualPayment: true`; 失败: `{ success: false, message }`, message 应保留上游文案(供风控分类) |

### 可选实现

| 接口 | 签名 | 说明 |
|---|---|---|
| `listSlots(query, cred)` | `→ [{ uid, court, begin, canAppoint }]` | 场次查询。slot 必须归一化为该形状, 供待支付释放轮询复用 |
| `payments` | `{ wechat: <code>, balance: <code> }` | 本场支付码语义声明。服务层经 `payCodes.paymentKind(venueId, code)` 解析, 授权校验/通知/兜底均依赖; 未声明时兜底下单码回退 40 |
| `classifyGrabResult(result)` | `→ success/rate-limited/not-released/release-pending/transient/terminal` | 风控分类, 未实现则用通用关键词分类 |
| `riskProfile` | `{ scopeKey, booking: { minIntervalMs, jitterMs, ... } }` | 限流与重试节奏配置 |
| `preheat(cred)` / `buildGrabRequest(target, cred)` + `fireGrab(prebuilt)` | — | 抢首发性能优化(连接预热/请求预构建) |

### venue.yml 声明式配置(参考 venues/picklepop)

```yaml
id: <venue-id>            # 必填, 即目录名
name: <展示名>             # 必填
logo: <图片URL>            # 可选, 球场卡片图标; 来源: HAR 中 system_store.image 或人工找图链
desc: <一句话描述>          # 可选, 球场卡片展示
backend:                  # 场地私有后端参数(适配器自取, 不展开到 meta 顶层)
  base / storeId / payMethodWechat / payMethodBalance ...
advanceDays:              # 类型→提前放场天数(整数), 供开抢时刻推算与日期选择范围
  <type>: 7
release:                  # 放场规则(开抢时刻推算)
  timezone: Asia/Shanghai
  rules:
    <type>:
      mode: calendar-day-batch
      calendarDaysBefore: 7      # 提前 N 个日历日
      at: '00:00:00.000'        # 当天放场时刻
bookingHours:             # 营业时段与时段粒度(前端时段格子生成)
  start: '07:00'          # 最早时段开始
  end: '23:00'            # 最晚时段结束(跨天加 overnight: true)
  overnight: false        # 跨零点营业
  slotMinutes: 60         # 时段粒度(分钟), 亦用于下单时段区间推算
releaseRetry:             # 放场重试策略(可选, 见 riskProfile)
courts:                   # 场地清单(前端场地选择/统计/下单 courtUid)
  - name: 1号             # 展示名
    type: tennis          # 类型(pickle/tennis, 前端统计与放场规则匹配)
    uid: '119'            # 上游场地唯一标识(字符串), 下单与 slot 匹配的关键
credentialSchema:         # 凭证字段声明, ingest/ CourtCapture 按此组装存储
  - key: Authori-zation   # 上游凭证 header 名(区分大小写按实际)
    label: 登录令牌        # 前端展示
    desc: 抓包获取说明
    maxAgeHours: 720      # 可选, 凭证过期提醒
capture:                  # CourtCapture/bot 抓包配置(见 COURTCAPTURE_GUIDE.md)
  enabled / hosts / paths / headers / discoveryPaths / tasks
```

**meta 展开规则**: `advanceDays/release/bookingHours/courts` 四个公开字段由 venueRegistry 注册时自动从 `meta.raw` 展开到顶层(适配器显式声明优先), 前端直接读 `venue.courts` 等; `backend/capture` 等敏感段只保留在 `venue.raw`。

**slot 归一化形状**(listSlots 返回, 契约强约束):

```js
{ uid, court, begin, canAppoint, cost }
// uid: 场地唯一标识(与 venue.yml courts.uid 对应)
// court: 场地名; begin: "YYYY-MM-DD HH:mm" 开始时刻
// canAppoint: 布尔, 可约(供待支付释放轮询判定)
// cost: 数字, 场次价格(供参考价接口 reference-price 汇总)
```

## 服务端存储

### 凭证 (credentials 表)

- 按 `(user_id, venue_id)` 主键存储, 值为 JSON 对象
- **自动采集** `POST /api/credentials/:venueId/ingest`: 客户端上传 `{"headers": {字段: 值}}`, 服务端按本场 `credentialSchema` 的 key 校验并组装(缺字段报错); 旧单值文本协议仅银豹兼容保留
- **手动更新** `PUT /api/credentials/:venueId`: 接受任意 JSON, 由适配器自行解释
- 存储后自动触发 `ready` 校验, 结果缓存在 credentials 表 `ready_ok`

### 任务 (jobs / job_history 表)

- `target_json` 透传创建参数(含 `ext.payMethod`/`ext.fallbackBalance`)
- 抢订结果存 `result_json`; 微信支付参数(`result.raw.script`)仅授权方本人查询任务时可提取(presentJob 的 paymentParams), 其他人不可见
- `job_attempts` 审计每次下单(计划/实际时刻/漂移/分类/耗时)

### 支付码语义 (payCodes)

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

## 新场地接入步骤清单

1. 用 CourtCapture 抓包(实时或 HAR 模式)获得 discovery 草稿(见 COURTCAPTURE_GUIDE.md)
2. 参考 `venues/picklepop/` 新建 `venues/<id>/venue.yml` + `index.js`
3. 实现必须接口(meta/ready/grab), 按 `capture` 配置补凭证抓取规则
4. 声明 `payments` 支付码; 若支持微信支付, grab 结果带 `requiresManualPayment`
5. 配置 `riskProfile` 限流(下单接口实测风控阈值, 参考 releaseRetry 校准)
6. 测试: `npm test`; 真实凭证 ready 校验; 小额下单验证
