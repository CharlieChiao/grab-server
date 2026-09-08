# 任务调度核心 (Scheduler Internals)

球场任务从创建到终态的完整调度链路与函数索引。适配器接入契约见 `VENUE_DEPLOY_CONTRACT.md`，抓包工具见 `COURTCAPTURE_GUIDE.md`。

## 调度全景

```
tick() 每 1s (src/core/scheduler.js)
 ├─ expireAwaitingPayments(now)      待支付超时判定/兜底      [paymentLifecycle]
 ├─ pollAwaitingPayments(now)        待支付释放轮询(1s)      [paymentLifecycle]
 ├─ 遍历 pending 任务:
 │    到点(fireAt<=now)  → runGrab(job)
 │    60s 内将到点       → schedulePreciseFire(job)   提前 15s preheat, setTimeout 毫秒级精发
 ├─ 每小时整点          → doReadyCheckAll("hourly")   所有活跃凭证体检
 └─ 10min 内有任务      → doReadyCheck(venueId, "pre-grab-1min") 抢前凭证确认
```

## runGrab 抢订状态机 (scheduler.js)

```
updateJob(running) → 循环 attempt 1..maxAttempts:
  enqueueBooking(scope, 限流队列内执行 grab/fireGrab)     [requestLimiter]
    ↓ classifyGrabResult / classifyResult 分类:
    success        → break → 待支付判定 → done
    release-pending(未放场)
        ├─ watchSlotRelease 配置开启 → canAppoint 短轮询(500ms±300ms 随机, 不占下单限流)
        │     ├─ 检测到可约 → continue(立即下单, 走限流队列正确排队)
        │     └─ 超时(默认3min)/连续10次查询错误 → break
        └─ 未开启 → 原重试(3s 间隔消耗 releaseMaxAttempts)
    not-released / transient → linearRetryDelay 重试
    rate-limited  → applyCooldown 后重试
    terminal      → break
  ↓ 失败终态:
    fallbackEnabled(job) → creatorBalanceFallback          [paymentLifecycle]
    refineUnavailableReason → 回查 listSlots 细分(已被预约/已被排课/已被锁场)
  ↓ updateJob(done|failed) → notifyJobResult → archiveJob → finalizeAndRepeatGroup
```

## 模块函数索引

### scheduler.js — 调度主循环
| 函数 | 说明 |
|---|---|
| `startScheduler()` / `stopScheduler()` | 启停 1s tick 循环 |
| `tick()` | 主循环: 支付生命周期轮询 + 任务触发 + 凭证体检 |
| `schedulePreciseFire(job, fireMs)` | 60s 内任务的毫秒级精发(15s preheat + setTimeout) |
| `runGrab(job, credential?, venue?)` | 抢订主流程(上述状态机) |
| `watchSlotRelease(venue, job, cred, cfg)` | 未放场时的 canAppoint 快轮询等待(查询接口不走限流) |
| `refineUnavailableReason(venue, job, cred, msg)` | 失败后回查场次细分原因 |
| `classifyResult(result)` | 通用风控分类(适配器未实现 classifyGrabResult 时的兜底) |
| `linearRetryDelay(profile, classification)` | 分类→重试间隔计算 |
| `recordAttempt(job, ...)` | 每次下单写 job_attempts 审计(计划/实际/漂移/分类) |
| `doReadyCheck(venueId, reason, userId)` / `doReadyCheckAll` | 凭证体检, 结果进 readyCache |
| `readyCache` | `Map<userId:venueId, {at, reason, result}>` 最近一次体检结果 |

### requestLimiter.js — 下单限流(防"操作太频繁")
| 函数 | 说明 |
|---|---|
| `enqueueBooking(venueId, profile, task, options?)` | 按 `scopeKey` 串行排队; 每单后强制 `minIntervalMs + jitter` 冷却; options 可覆盖间隔(watch 后下单/放场重试用) |
| `applyCooldown(scopeKey, ms)` | rate-limited 时追加冷却 |
| `resetLimiterState()` | 清空队列与状态(测试用) |

**scopeKey 规则**: `venue.scopeKey + ":" + userId`(店铺+凭证用户)。银豹风控是用户凭证级——同凭证的主抢订/兜底/重试共享队列串行; 不同凭证并行。canAppoint 查询(watch/释放轮询)**不进此队列**。

### paymentLifecycle.js — 待支付与兜底
| 函数 | 说明 |
|---|---|
| `requiresManualPayment(job, result)` | 委托任务+抢订成功+适配器声明 `requiresManualPayment` → 进入待支付窗口 |
| `markAwaitingPayment(job, result, elapsedMs)` | 转 awaiting_payment, 设 15min 窗口 |
| `finishPayment(jobId)` | 授权方确认支付 → done |
| `expireAwaitingPayments(now)` | 窗口到期: 兜底或超时失败(消息含"实际等待 X 分 Y 秒") |
| `pollAwaitingPayments(now)` | 1s 轮询目标场次是否重新可约(=订单释放) → 提前兜底/失败 |
| `targetSlotsAvailable(target, slots)` | 目标场次(courts/court+time)是否 canAppoint, 释放轮询与 watch 共用 |
| `fallbackEnabled(job)` | `target.ext.fallbackBalance === true` 且委托任务 |
| `fallbackBalanceBooking(job, msg, now)` | 两层兜底: 授权方(B)余额 → 创建者(A)本人余额 |
| `creatorBalanceFallback(job, sinceMs)` | 余额支付抢订失败时, 直接用 A 本人凭证余额兜底 |
| `attemptBalanceBooking(venue, job, cred, via, sinceMs)` | 单次余额下单(限流 scope 按下单用户隔离), 输出 dispatch 延迟日志 |
| `finishAndArchive(job)` | 通知+归档+任务组收尾的公共出口 |

### jobStore.js — 任务存储(SQLite jobs / job_history)
| 函数 | 说明 |
|---|---|
| `createJob({userId, createdByUserId, delegationId, groupUid, venueId, target, fireAt})` | 创建 pending 任务 |
| `listJobs()` / `listJobsForUser(uid)` / `listHistoryForUser(uid)` | 全量(调度用)/待执行/历史 |
| `getJob(id, userId)` | 按 owner 或创建者可见, 兼查两张表 |
| `updateJob(id, patch)` | 状态/结果/时间更新(scheduler 高频调用) |
| `editJob(id, userId, {fireAt, cost, groupUid, fallbackBalance})` | 小程序编辑(仅 pending, 价格三处同步) |
| `archiveJob(id)` | jobs → job_history 事务迁移 |
| `deleteJob(id, userId)` | 删除(两表) |

### jobGroups.js — 任务组
| 函数 | 说明 |
|---|---|
| `createJobGroup(userId, input)` / `getJobGroup` / `listJobGroups` / `updateJobGroup` / `stopJobGroup` | 组 CRUD(repeatWeekly 每周迭代) |
| `requireWritableGroup(uid, userId)` | 创建任务时的组校验(active 且本人) |
| `finalizeAndRepeatGroup(groupUid)` | 任务终态后收尾: 按成功策略定 outcome, 周重复组复制下一周 |
| `presentGroup(row)` / `counts(uid)` | 组展示(统计 UNION 两张表) |

### venueRegistry.js — 适配器注册(热更)
| 函数 | 说明 |
|---|---|
| `loadVenues()` | 扫描 `src/venues/*`, import 适配器并注册。**import URL 带时间戳绕过 ESM 模块缓存**——venue-config 保存后热更生效的关键 |
| `getVenue(id)` / `listVenues()` | 取适配器 / 前端 meta 列表 |

### 配置与校准辅助
| 函数 | 模块 | 说明 |
|---|---|---|
| `computeReleaseTimeUTC(date, daysBefore, at)` | timeUtil.js | 放场时刻推算(UTC) |
| `autoFireAt(venueMeta, target)` | timeUtil.js | 创建任务时的默认开抢时刻 |
| `getRiskProfile` / `recordRiskEvent` / `saveRiskProfile` | riskProfile.js | 限流画像(风控事件自动加大间隔, 持久化 risk-profiles.json) |
| `calibrateUnavailableRetry(...)` / `startUnavailableRetryCalibration` | releaseProbe.js | 放场重试间隔实测校准 |
| `paymentKind(venueId, code)` | payCodes.js | 支付码→balance/wechat 语义(服务层禁止裸数字) |
| `getCredential(venueId, userId)` | credentialStore.js | 凭证读取(无记录返回 null) |

## venue.yml 调度相关配置速查

```yaml
release.rules.<type>:     # 开抢时刻 = 场次日期 - calendarDaysBefore 天 的 at 时刻
bookingHours:             # start/end/slotMinutes(跨天可 end<start 自动+24h)
releaseRetry:             # 放场重试: unavailableGraceMs 宽限 / defaultMinIntervalMs / maxAttempts
  watchSlotRelease: true  # 未放场转 canAppoint 短轮询(不占下单限流, 不阻塞兜底)
  watchIntervalMs: 500    # 轮询基础间隔(±watchJitterMs 随机)
  watchTimeoutMs: 180000  # watch 总时长上限
```

修改路径: 小程序 venue-config 页(表单/源码模式) → `PUT /api/developer/venue-configs/:id` → 写盘 + `loadVenues()` **即时热更**, 注释保留(structured patch 模式), 失败自动回滚备份。

## 数据表

| 表 | 内容 |
|---|---|
| `jobs` / `job_history` | 待执行 / 已终态任务(target_json, result_json, fire_at, group_uid...) |
| `job_attempts` | 每次下单审计(attempt, planned_at, dispatched_at, drift_ms, classification, message) |
| `credentials` | (user_id, venue_id) 凭证 JSON |
| `task_groups` | 任务组(success_policy, repeat_weekly, series_uid, iteration) |
| `delegations` | 委托授权(allowed_payments_json, 时效) |
