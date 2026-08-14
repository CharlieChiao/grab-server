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

## 快速更新 PSPLVISITORID

当微信小程序中的 PSPLVISITORID 失效时：

1. 在电脑上打开微信小程序，抓取请求头中的 PSPLVISITORID。
2. 复制完整请求头，或只复制 PSPLVISITORID 的值。
3. 在 PowerShell 中设置服务器令牌：

    $env:CREDENTIAL_UPDATE_TOKEN = "部署时生成的固定令牌"

4. 运行上传脚本：

    ./tools/update-credential.ps1

脚本默认读取剪贴板，并发送到 picklepop。也可以直接传值：

    ./tools/update-credential.ps1 -Value "PSPLVISITORID的值"

上传接口会先保存凭证，再执行一次 ready 验证；输出 ready=True 才表示当前凭证有效。令牌只在首次部署或主动轮换时生成，不需要每次重新生成。不要把令牌提交到 Git 或发送给其他人。


## GUI 自动捕获工具

已生成 Windows 可执行文件：

    dist/CourtCredentialCapture.exe

使用步骤：

1. 首次运行前，确认电脑已有 mitmproxy 证书。若没有，先运行一次 mitmproxy/mitmdump，按界面提示安装证书；工具检测不到证书时会提示证书路径，不会静默安装。
2. 双击 `CourtCredentialCapture.exe`，点击“显示配对二维码”。
3. 在 Chai 小程序的设置页点击“扫码配对”，扫描电脑上的二维码。每台电脑只需首次配对一次；设备密钥保存在当前 Windows 用户的应用数据目录中，不需要填写服务器、球场 ID、端口或固定令牌。
4. EXE 会从服务器读取可用球场及当前 ready 状态。选择球场后点击“开始监听”。
5. 电脑微信直接打开球场小程序；或者让手机和电脑连接同一 Wi-Fi，并把手机代理设置为工具界面显示的局域网 IP 和端口。
6. 打开目标球场的场地/时段页面。工具按 `venue.yml` 的捕获规则自动提取并上传凭证；命中 `discoveryPaths` 时还会自动发现真实 `classroomUid` 和场地名称。
7. 看到 READY 表示服务器已经用当前用户的新凭证验证成功。结束后点击“停止监听”，再关闭工具。

手机模式需要手机信任 mitmproxy 证书；这是 HTTPS 解密的必要条件。工具不会上传完整请求或响应，只上传 YAML 声明的凭证字段，以及发现到的场地名称和真实上游 ID。每次上传均使用已配对设备的时间戳和 HMAC 签名，服务器会将数据写入扫码用户自己的账户。

新增球场时，在对应 venue.yml 增加：

    capture:
      enabled: true
      hosts:
        - example.com
      paths:
        - /api/login/*
      headers:
        - PSPLVISITORID

重新打包：

    powershell -ExecutionPolicy Bypass -File tools/capture_tool/build.ps1


## 多用户数据隔离

服务器使用 SQLite 保存用户、球场凭证和订场任务：

    data/grab.sqlite

凭证和任务按微信用户与 venueId 隔离，不同用户不会读取到彼此的凭证。旧版 data/credentials.json 和 config/jobs.json 会在首次启动时迁移到 legacy-owner，第一个完成微信认证的账号会自动认领旧数据。

认证需要配置同一个服务器密钥：

- grab-server：环境变量 GRAB_API_AUTH_SECRET
- quickstartFunctions 云函数：云函数环境变量 GRAB_API_AUTH_SECRET

这两个值必须完全一致，不能写入小程序前端代码。修改云函数后，需要重新上传部署 quickstartFunctions。

