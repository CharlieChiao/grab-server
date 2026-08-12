# 球场抢订平台后端 (grab-court-server)

Node.js 主后端：定时抢订 + ready 检测 + 插件化球场适配器。目前内置 **PICKLE POP**（银豹 Pospal 后端），可纯脚本用会员余额支付闭环下单。

## 快速开始

```bash
npm install
node server.js          # 默认端口 3000, 可用 PORT=8080 node server.js
```

启动后访问 `http://localhost:3000/` 查看接口列表。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/jobs` | 创建定时任务 |
| GET | `/api/jobs` | 查询所有定时任务 |
| GET | `/api/jobs/:id` | 查询单个任务 |
| DELETE | `/api/jobs/:id` | 删除定时任务 |
| GET | `/api/venues` | 列出所有球场(展示信息) |
| GET | `/api/venues/:id` | 单个球场配置 |
| GET | `/api/ready/:venueId` | **实时 ready 检测**(picklepop = PSPLVISITORID 有效性) |
| GET | `/api/ready/:venueId/cache` | 最近一次心跳检测结果 |
| GET | `/api/credentials/:venueId` | 查看凭证是否已配置(脱敏) |
| PUT | `/api/credentials/:venueId` | 更新球场凭证(如更新 PSPLVISITORID) |

### 创建定时任务示例

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  --data-binary '{
    "venueId": "picklepop",
    "target": { "court": "网球1号澳网风", "date": "2026-08-19", "time": "14:00", "cost": 99 },
    "fireAt": "2026-08-19T00:00:00.000Z"
  }'
```

- `fireAt`: 开抢时刻(ISO, UTC)。**留空/null = 立即执行**。
- `target.court`: 场地名(见 venue.yml)或直接传 classroomUid。
- `target.ext`: 可选。`{ payMethod, projectType, maxRetry, retryInterval }`。
  - `payMethod` 默认 40(余额支付)；900 为微信支付(会返回需手动付的 script)。

### 更新 PSPLVISITORID(失效时)

```bash
curl -X PUT http://localhost:3000/api/credentials/picklepop \
  -H "Content-Type: application/json" \
  --data-binary '{"PSPLVISITORID":"<新抓到的值>"}'
```

## 调度行为(自动)

- **定时开抢**：到 `fireAt` 时刻执行 `grab`，失败按 `maxRetry`/`retryInterval` 快速重试。
- **每小时心跳**：对有任务的球场做一次 ready 检测，结果存入缓存。
- **临近开抢加密检测**：任一任务开抢前 10 分钟内，每分钟做一次 ready 检测(提前发现凭证失效)。

## 目录结构

```
server.js                     主入口
src/
  api/{jobs.js, ready.js}      HTTP 接口
  core/
    scheduler.js               调度(开抢/心跳/临近检测)
    jobStore.js                任务持久化(config/jobs.json)
    credentialStore.js         凭证(data/credentials.json)
    venueRegistry.js           自动发现加载球场适配器
    types.js                   统一适配器接口规范
  venues/
    picklepop/
      index.js                 适配器: 实现 ready/grab/listSlots
      venue.yml                声明式配置(UI/场地/接口/放场规则)
config/jobs.json               任务数据(自动生成)
data/credentials.json          凭证(不入git)
```

## 如何新增一个球场(扩展规范)

新增球场**无需改动主程序**，只要在 `src/venues/` 下加一个目录：

1. **建目录** `src/venues/<yourVenueId>/`
2. **写 `venue.yml`**：声明式配置(展示名、logo、场地列表、后端参数、放场规则、凭证 schema)。
3. **写 `index.js`**：实现并 `export default` 一个对象，包含：
   - `meta`：`{ id, name, logo, desc, courts, ... }`(通常从 venue.yml 读)
   - `ready(cred) -> {ok, detail, extra?}`：**ready 检测入口**。返回是否可抢。
     - 对 picklepop 是 PSPLVISITORID 有效性；其他球场可以是 token 校验/登录态等。
   - `grab(target, cred) -> {success, orderId?, message, raw?}`：**抢票入口**。
   - `listSlots(query, cred)`(可选)：查可约时段。
4. **配凭证**：在 `data/credentials.json` 加 `"<yourVenueId>": { ... }`。
5. 重启服务，`venueRegistry` 会自动发现加载。

> 统一接口定义见 `src/core/types.js`。只要实现 `meta/ready/grab`，就能复用定时调度、ready 心跳、全部 HTTP API。

## 部署建议(你的服务器)

- 用 `pm2` 常驻：`pm2 start server.js --name grab-court`
- 反向代理(nginx)对外，加简单鉴权(避免接口裸奔)。
- `data/credentials.json` 权限收紧，勿入库。
- 服务器建议选在**国内、离银豹服务器网络较近**的机房，降低抢单延迟。
