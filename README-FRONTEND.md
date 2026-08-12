# 球场抢订平台 — 微信小程序前端对接文档

本文档面向**微信小程序前端**，说明如何调用后端接口、请求/返回的参数格式，以及完整调用示例（含 `wx.request` 代码）。

---

## 一、基础信息

| 项 | 值 |
|---|---|
| 生产域名（HTTPS） | `https://api.cn.orangechai.fun` |
| 接口前缀 | `/grab` |
| 完整 Base URL | `https://api.cn.orangechai.fun/grab` |
| 数据格式 | 请求体、响应体均为 JSON（`Content-Type: application/json`） |
| 字符编码 | UTF-8 |

> **小程序合法域名配置**：在微信公众平台 →「开发管理」→「开发设置」→「服务器域名」的 **request 合法域名** 中，添加 `https://api.cn.orangechai.fun`。

### 统一返回约定

- 成功：HTTP 200，返回体一般含 `{"ok": true, ...}`。
- 失败：HTTP 400 / 404，返回体含 `{"error": "错误描述"}`。

---

## 二、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/venues` | 列出所有球场（含场地列表） |
| GET | `/api/venues/:id` | 单个球场配置 |
| GET | `/api/ready/:venueId` | 实时 ready 检测（凭证是否有效） |
| GET | `/api/ready/:venueId/cache` | 最近一次心跳检测结果 |
| GET | `/api/credentials/:venueId` | 查看凭证是否已配置（脱敏） |
| PUT | `/api/credentials/:venueId` | 更新球场凭证 |
| POST | `/api/jobs` | 创建定时抢订任务 |
| GET | `/api/jobs` | 查询所有任务 |
| GET | `/api/jobs/:id` | 查询单个任务 |
| DELETE | `/api/jobs/:id` | 删除任务 |

> 当前后端内置球场：`picklepop`（PICKLE POP 匹克球&网球 宝安摩天轮馆）。下文示例均以 `venueId = picklepop` 为例。

---

## 三、接口详情

### 1. 健康检查

```
GET /grab/health
```
返回：`{ "ok": true, "time": "2026-08-12T10:36:02.990Z" }`

---

### 2. 列出所有球场

```
GET /grab/api/venues
```

**返回**
```json
{
  "ok": true,
  "venues": [
    {
      "id": "picklepop",
      "name": "PICKLE POP 匹克球&网球（宝安摩天轮馆）",
      "logo": "https://img.pospal.cn/storeLogo/....jpg",
      "advanceDays": { "pickle": 7, "tennis": 3 },
      "courts": [
        { "name": "匹克球1号", "type": "pickle", "uid": "..." },
        { "name": "网球1号澳网风", "type": "tennis", "uid": "..." }
      ]
    }
  ]
}
```

**关键字段**

| 字段 | 说明 |
|---|---|
| `advanceDays.pickle` | 匹克球提前 7 天放场 |
| `advanceDays.tennis` | 网球提前 3 天放场 |
| `courts[].name` | 场地名，**创建任务时用此值作为 `court`** |
| `courts[].type` | `pickle` / `tennis` |

**picklepop 当前场地**：匹克球 1~6 号；网球 1 号澳网风 / 2 号法网风 / 3 号法网风

---

### 3. 单个球场配置

```
GET /grab/api/venues/picklepop
```
返回：`{ "ok": true, "meta": { ... } }` 未找到时 HTTP 404。

---

### 4. 实时 ready 检测 ⭐

抢订前**强烈建议**先调用，确认凭证（`PSPLVISITORID`）有效。

```
GET /grab/api/ready/picklepop
```

**返回（有效）**
```json
{
  "ok": true,
  "venueId": "picklepop",
  "detail": "已登录: 张三 15600758682",
  "extra": { "balance": 200, "uid": "xxxx" }
}
```

**返回（凭证无效）**
```json
{ "ok": true, "detail": "登录态无效(可能PSPLVISITORID已过期,需重新抓包)", "extra": { ... } }
```

> **注意**：`ok:true` 只代表接口通了。**凭证是否真的有效，要看 `detail` 是否以 "已登录" 开头**。

---

### 5. 缓存的心跳检测结果

```
GET /grab/api/ready/picklepop/cache
```
返回上次心跳的缓存结果（`{ ok:true, cached:{...} | null }`），不发起真实请求，更快。

---

### 6. 查看凭证是否已配置

```
GET /grab/api/credentials/picklepop
```
返回：`{ "ok": true, "configured": true, "keys": ["PSPLVISITORID"] }`（脱敏，不返回明文）。

---

### 7. 更新凭证

```
PUT /grab/api/credentials/picklepop
Content-Type: application/json

{ "PSPLVISITORID": "<新抓到的值>" }
```
返回：`{ "ok": true, "saved": true }`

---

### 8. 创建定时抢订任务 ⭐⭐

```
POST /grab/api/jobs
Content-Type: application/json
```

#### 请求体（三种典型形态）

**形态 A：单场地**
```json
{
  "venueId": "picklepop",
  "target": {
    "court": "网球1号澳网风",
    "date": "2026-08-22",
    "time": "14:00",
    "cost": 99
  }
}
```

**形态 B：多场地（同一时段一起抢，同一订单一次下单）**
```json
{
  "venueId": "picklepop",
  "target": {
    "date": "2026-08-22",
    "time": "14:00",
    "cost": 99,
    "courts": ["网球1号澳网风", "网球2号法网风"]
  }
}
```
> **`cost` 是"每个场地"的单价**，后端会自动求和为订单总金额。

**形态 C：多场地/不同时段（对象数组）**
```json
{
  "venueId": "picklepop",
  "target": {
    "date": "2026-08-22",
    "courts": [
      { "court": "网球1号澳网风", "time": "14:00", "cost": 99 },
      { "court": "网球2号法网风", "time": "15:00", "cost": 99 }
    ]
  }
}
```

#### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `venueId` | string | 是 | 球场 ID（当前只有 `picklepop`） |
| `target` | object | 是 | 抢订目标，见下方 |
| `fireAt` | string \| null | 否 | 开抢时刻（ISO 8601 UTC）。**留空则由后端自动推算**（推荐） |
| `fireImmediately` | boolean | 否 | **前端"立即"按钮 → 传 `true`**，忽略 `fireAt`，立刻执行（**仅供测试用**） |

#### `target` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `date` | string | 是 | 预订日期 `YYYY-MM-DD` |
| `court` | string | 单场地必填 | 场地名（见 `/api/venues`） |
| `courts` | (string \| object)[] | 多场地必填 | 数组：字符串数组 或 `{court, time, cost}` 对象数组 |
| `time` | string | 见说明 | 开始时间 `HH:mm`。**单场地必填；多场地时若每项没写 time 则顶层必填** |
| `cost` | number | 见说明 | 该场地单价（元）。单场地必填；多场地时同 `time` 规则 |
| `ext` | object | 否 | 高级参数（见下） |

> **注意**：`court` 与 `courts` **不能同时存在**（会 400）。

#### `target.ext` 可选参数

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `payMethod` | number | `40` | `40`=会员余额支付（推荐）；`900`=微信支付（返回需手动付款的 script） |
| `projectType` | number | `0` | 项目类型 |
| `maxRetry` | number | `20` | 抢单最大重试次数 |
| `retryInterval` | number | `200` | 重试间隔（毫秒） |

#### 后端自动算 `fireAt`（重要）

后端会按 `advanceDays` 自动算放场时刻，**前端不用传** `fireAt`：

- 单场地：`放场日 = 预订日 − 该场地的 advanceDays`，时刻 = 北京时间 `00:00:00`
- 多场地：取所选场地中**最小的** `advanceDays`（放场最晚者），保证到点时全部已放场

**示例**（抢 `2026-08-22`）：
- 网球（advanceDays=3）→ `fireAt = 2026-08-19 00:00 北京 = 2026-08-18T16:00:00.000Z`
- 匹克球（advanceDays=7）→ `fireAt = 2026-08-15 00:00 北京 = 2026-08-14T16:00:00.000Z`

#### "立即执行"开关

前端页面有一个「**立即**」开关（用于测试服务）：

- **未勾选**：不传 `fireImmediately`（或传 `false`），后端自动算 `fireAt`
- **勾选**：`fireImmediately: true`，立刻执行

#### 返回体

```json
{
  "ok": true,
  "fireAtSource": "auto",
  "job": {
    "id": "uuid",
    "venueId": "picklepop",
    "target": { "..." : "..." },
    "fireAt": "2026-08-18T16:00:00.000Z",
    "status": "pending",
    "result": null,
    "createdAt": "2026-08-12T15:27:09.351Z",
    "updatedAt": "2026-08-12T15:27:09.351Z"
  }
}
```

**`fireAtSource` 表示 `fireAt` 从哪来**：
- `auto`：后端按 `advanceDays` 自动算
- `client`：前端显式传的
- `immediate`：`fireImmediately:true` 立即执行（`fireAt` 为 `null`）

#### 常见错误

| HTTP | error 文案 |
|---|---|
| 400 | `venueId 必填` |
| 400 | `未知球场: xxx` |
| 400 | `target.date 必填 (YYYY-MM-DD)` |
| 400 | `target.court 或 target.courts 至少提供一个` |
| 400 | `target.court 与 target.courts 不能同时存在` |
| 400 | `target.time 必填 (HH:mm)`（多场地时若顶层与每项都没 time） |
| 400 | `target.courts[i].court 必填` |

#### `job.status` 枚举

| 值 | 含义 |
|---|---|
| `pending` | 等待开抢 |
| `running` | 抢单中 |
| `done` | 成功 |
| `failed` | 失败 |
| `canceled` | 已取消 |

---

### 9. 查询所有任务

```
GET /grab/api/jobs
```
返回：`{ "ok": true, "jobs": [ ... ] }`

---

### 10. 查询单个任务 ⭐（轮询抢订结果）

```
GET /grab/api/jobs/:id
```

**返回（成功）**
```json
{
  "ok": true,
  "job": {
    "id": "...",
    "status": "done",
    "result": {
      "success": true,
      "orderId": "订单号",
      "message": "抢到并已余额支付",
      "elapsedMs": 178
    }
  }
}
```

**`job.result` 字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `success` | boolean | 是否成功 |
| `orderId` | string | 银豹订单号（apptUid），成功时返回 |
| `message` | string | 结果文案，可直接展示 |
| `elapsedMs` | number | 首发+重试的总耗时（毫秒） |

> 若 `success:true` 且 `message` 含"需手动支付"，表示下单成功但需用户手动完成微信支付（余额不足或选了微信支付）。

未找到：HTTP 404 `{ "error": "not found" }`

---

### 11. 删除任务

```
DELETE /grab/api/jobs/:id
```
返回：`{ "ok": true }`。`ok:false` 表示 id 不存在。

---

## 四、小程序调用示例（wx.request）

### 封装统一请求

```js
// utils/api.js
const BASE = 'https://api.cn.orangechai.fun/grab';

function request(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE + path,
      method,
      data,
      header: { 'Content-Type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(res.data || { error: '请求失败', statusCode: res.statusCode });
        }
      },
      fail: reject,
    });
  });
}

module.exports = {
  getVenues: () => request('GET', '/api/venues'),
  checkReady: (venueId) => request('GET', `/api/ready/${venueId}`),
  updateCredential: (venueId, cred) => request('PUT', `/api/credentials/${venueId}`, cred),
  createJob: (payload) => request('POST', '/api/jobs', payload),
  listJobs: () => request('GET', '/api/jobs'),
  getJob: (id) => request('GET', `/api/jobs/${id}`),
  deleteJob: (id) => request('DELETE', `/api/jobs/${id}`),
};
```

### 示例 1：单场地 + 后端自动算 fireAt（最常用）

```js
const api = require('../../utils/api');

async function bookOne() {
  // 1. 检测凭证
  const r = await api.checkReady('picklepop');
  if (!/^已登录/.test(r.detail || '')) {
    wx.showToast({ title: '凭证已失效', icon: 'none' });
    return;
  }
  // 2. 创建任务(不传 fireAt, 后端自动算)
  const { job, fireAtSource } = await api.createJob({
    venueId: 'picklepop',
    target: {
      court: '网球1号澳网风',
      date: '2026-08-22',
      time: '14:00',
      cost: 99,
    },
  });
  console.log('放场时刻:', job.fireAt, '来源:', fireAtSource);
  wx.showToast({ title: '定时任务已创建' });
}
```

### 示例 2：多场地（用户勾选了多个场地）

```js
async function bookMulti(selectedCourts /* ['网球1号澳网风','网球2号法网风'] */) {
  const { job } = await api.createJob({
    venueId: 'picklepop',
    target: {
      date: '2026-08-22',
      time: '14:00',
      cost: 99,                 // 每个场地的单价
      courts: selectedCourts,   // 一次下单同时抢多个场地
    },
  });
  console.log('多场地任务:', job.id);
}
```

> **说明**：这跟银豹小程序原生「同一天多场地一起下单」行为一致——**一次订单包含多个场地，全部成功或全部失败**。总金额 = 单价 × 场地数（后端自动求和）。

### 示例 3：多场地不同时段

```js
async function bookMultiSlots() {
  const { job } = await api.createJob({
    venueId: 'picklepop',
    target: {
      date: '2026-08-22',
      courts: [
        { court: '网球1号澳网风', time: '14:00', cost: 99 },
        { court: '网球2号法网风', time: '15:00', cost: 99 },
      ],
    },
  });
}
```

### 示例 4：立即执行（"立即"按钮勾选）

```js
async function bookNow(form /* 表单收集到的 target */) {
  const { job, fireAtSource } = await api.createJob({
    venueId: 'picklepop',
    target: form,
    fireImmediately: true,   // <-- "立即" 开关勾选时传 true
  });
  console.log('立即执行:', fireAtSource, 'jobId=', job.id);
  // 立即执行的任务几乎马上会有结果, 直接轮询
  pollJob(job.id);
}
```

### 示例 5：轮询任务结果

```js
function pollJob(id) {
  const timer = setInterval(async () => {
    try {
      const { job } = await api.getJob(id);
      if (['done', 'failed', 'canceled'].includes(job.status)) {
        clearInterval(timer);
        const msg = job.result?.message || job.status;
        wx.showModal({
          title: job.status === 'done' ? '抢订成功' : '抢订失败',
          content: msg,
          showCancel: false,
        });
      }
    } catch (e) {
      clearInterval(timer);
      wx.showToast({ title: '查询失败', icon: 'none' });
    }
  }, 3000);
}
```

---

## 五、典型使用流程

1. `GET /api/venues` → 渲染球场与场地选择（**支持多选**）
2. `GET /api/ready/picklepop` → 检测凭证；失效时提示更新
3.（可选）`PUT /api/credentials/picklepop` → 提交新的 PSPLVISITORID
4. 用户选择：
   - 日期、时间
   - **一个或多个场地**
   - 「立即」开关（测试用；正式抢订**不要**勾）
5. `POST /api/jobs` 创建任务，拿到 `job.id`
6. `GET /api/jobs/:id` 轮询状态，展示结果

---

## 六、时间说明

- `date` / `time` 是**场次时间**，按北京时间填写（`YYYY-MM-DD` / `HH:mm`），不用转 UTC
- `fireAt` 是**开抢时刻**，UTC ISO 8601 格式
  - 前端**通常不用管**（后端会自动算）
  - 如需手动传，用 `new Date(...).toISOString()`

---

## 附：错误码

| HTTP | 场景 | 返回体 |
|---|---|---|
| 200 | 成功 | `{ "ok": true, ... }` |
| 400 | 参数缺失/非法 | `{ "error": "..." }` |
| 404 | 资源不存在 | `{ "error": "not found" }` 或 `{ "error": "未知球场" }` |
