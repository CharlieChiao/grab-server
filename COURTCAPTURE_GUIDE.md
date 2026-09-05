# CourtCapture 抓包与发现指南

CourtCapture 是配套的 Windows 桌面客户端(独立仓库 `CourtCapture/`), 负责凭证抓取与新球场 API 发现。本文档描述其工作模式、草稿产物与安全策略; 服务端契约见 `VENUE_DEPLOY_CONTRACT.md`。

## 模式一: 已配置球场的凭证监听

由 venue.yml 的 `capture` 段驱动, 完全配置化:

```yaml
capture:
  enabled: true
  hosts: [wxservice-stg48.pospal.cn]   # 监听域名
  paths: ['*']                          # 路径过滤(尾通配)
  headers: [PSPLVISITORID]              # 凭证字段(逐个从请求头提取)
  discoveryPaths: [...]                 # 场地发现接口
  tasks: [...]                          # 采集任务清单(前端展示)
```

客户端 mitmproxy 代理命中 hosts+paths 且 headers 有值 → 上传全部提取字段 → 服务端按 `credentialSchema` 组装存储并自动 ready 校验。

## 模式二: 新球场发现(实时监听)

1. `POST /api/venue-discovery/sessions` 创建会话
2. 客户端收集 HTTPS/JSON 流量(域名黑名单/支付敏感内容丢弃)
3. 入口候选按启发式排序(球场名命中×100 + 同域名关联度), 用户锚定一条入口请求 → `POST /:id/lock-entry` 锁定服务 origin
4. 四阶段引导(账户验证→场地→场次→下单)逐阶段上传事件
5. `POST /:id/finalize` 生成草稿 manifest

## 模式三: 新球场发现(HAR 导入)

离线导入历史抓包(Quantumult X / Charles / Chrome 导出的 HAR):

1. 导入 HAR 文件(可多选) → 解析全部条目, 按 origin 汇总候选(名称匹配+请求数+JSON 数启发式排序)
2. 用户锚定一条球场服务请求(列表含接口路径预览辅助判断)
3. lock-entry 锁定 origin 后, 同域流量回放: 每条请求按关键词规则**自动分阶段**
   - 读动词(Load/Get/Query/List)优先归类 account/courts/slots 查询阶段
   - 仅 POST 且含写动词(Create/Save/Submit/Reserve)才判 booking
   - 银豹类后端查询接口也走 POST, 故不能只按 method 区分
4. 逐条上传 → finalize 生成草稿, 与实时模式产物一致

回放复用与实时模式相同的 CaptureAddon 识别逻辑(scope 过滤/支付丢弃/脱敏), 零重复实现。

## 草稿 manifest 与适配器的差距

草稿(存 `venue_discovery_drafts` 表)每阶段保留得分最高的 API: method/path/请求头名/请求响应类型骨架/slot 时长统计/置信分。

**写适配器仍需人工补充**(manifest 只有类型骨架无值):
- 凭证真实值(加密原文库可查)
- 请求样本值(storeId/courtUid 等, 加密原文库可查)
- slot 字段映射(哪个字段是 uid/可约标志)
- venue.yml 运营参数(放场规则/限流阈值/营业时段/支付码声明)

注: 下单请求体中的 `payMethod` 等静态参数**不会被支付过滤拦截**("payMethod" 不含 payment/paysign 等子串), 其值可通过加密原文库查询, 用于填写适配器的 `payments` 声明。

## 安全策略

| 丢弃内容 | 例子 | 位置 |
|---|---|---|
| 支付凭据 | `paySign`/`prepay_id`/支付接口 URL(cashier/unifiedorder) | 客户端 PAYMENT_WORDS + 服务端 PAYMENT_PATTERN 双重拦截 |
| 个人敏感字段 | `password`/`bank`/`cardno`/`cvv`/`idcard` | 客户端 DROP_KEYS 脱敏删除 |

静态业务参数(如 payMethod 支付方式码)不属于敏感内容, 正常采集。原文含真实值的事件以 AES-256-GCM 加密存储, manifest 仅含骨架。
