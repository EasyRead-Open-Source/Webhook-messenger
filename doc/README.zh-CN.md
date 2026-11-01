# App Store → 飞书 Worker

[English](../README.md) | [简体中文](README.zh-CN.md)

本项目是使用 JavaScript 编写的 Cloudflare Worker，用于验证 Apple webhook，并将事件转换为飞书自定义机器人消息卡片。支持 App Store Connect 开发流程事件和 App Store Server Notifications V2，订阅通知的生产环境与沙盒环境使用独立入口。

```text
Apple → Worker 验签 → Durable Object 持久化队列 → 飞书签名消息卡片
```

## 支持的通知

| Apple 服务 | 常见事件 | 来源验证方式 |
| --- | --- | --- |
| App Store Connect Webhooks | 应用审核与版本状态、构建上传、TestFlight、资源包事件 | webhook 共享密钥，对原始请求体进行 HMAC-SHA256 验证 |
| App Store Server Notifications V2 | 购买、订阅、续费、退款及其他 V2 事件 | Apple 证书链及 JWS 签名验证 |

可以只启用其中一种，也可以同时启用。每次部署对应一个应用和一个飞书机器人。卡片只展示 Apple 已提供的部分字段；Worker 不会再调用 Apple API 查询应用元数据、反馈正文或崩溃报告。

## 配置顺序

1. 创建飞书自定义机器人，开启签名校验。
2. 为 V2 准备应用标识和 Apple 根证书。
3. 安装依赖、运行测试，将代码部署到 Cloudflare。
4. 配置生产 Worker Secrets。
5. 在 App Store Connect 中填写相应回调 URL，并验证通知投递。

## 功能

- Connect Webhooks：使用 `x-apple-signature`，对原始请求字节验签，并以恒定时间比较签名。
- Server Notifications V2：使用 Apple 官方 Node.js 验签库，验证证书链、ES256 签名、Bundle ID、生产环境 Apple ID 和通知环境；展示交易或续费字段前，也验证其嵌套 JWS。
- 飞书签名校验为必需项，不提供无签名发送模式。
- 卡片包含状态颜色、状态变化、UTC 时间、可用的商品与续费信息，以及 App Store Connect 跳转按钮。
- 支持自定义关键词和按事件 @ 提醒；@ 所有人必须显式配置 `all`。
- 使用 SQLite Durable Object 持久化队列，实现原子入队与去重、每秒最多发送一次、指数退避重试和过期清理。
- 凭据全部从 Worker 的 `env` 读取；项目代码不记录原始载荷、签名、webhook 地址、密钥、账户令牌或交易 ID。

## 环境要求

- Node.js 22 或更新版本、npm。
- 支持 SQLite Durable Objects 的 Cloudflare 账户。
- 已加入目标飞书群、开启了**签名校验**的自定义机器人。
- App Store Connect Webhooks 和/或 App Store Server Notifications **V2** 配置权限。
- 运行测试时，需要能从 PATH 调用 OpenSSL。

`package-lock.json` 已锁定 Wrangler、配套 Miniflare 和 Apple 验签库版本。当前 Wrangler 使用带 beta 标记的 Miniflare 依赖，升级时应一起验证。

## 本地准备

在仓库根目录执行：

```sh
npm ci
cp .dev.vars.example .dev.vars
```

在本机私下编辑 `.dev.vars`。该文件已被 Git 忽略；示例文件只包含无效占位值，不包含真实凭据。不要把真实值写进源代码、README、聊天记录或命令行参数。

| 变量 | 用途 | 必需范围 |
| --- | --- | --- |
| `FEISHU_WEBHOOK_URL` | 飞书机器人完整地址，格式为 `https://open.feishu.cn/open-apis/bot/v2/hook/...` | 所有投递 |
| `FEISHU_SIGNING_SECRET` | 飞书机器人「签名校验」提供的密钥 | 所有投递 |
| `APP_STORE_CONNECT_WEBHOOK_SECRET` | 与 Connect webhook 中 Secret 相同的共享密钥 | Connect 入口 |
| `APP_STORE_BUNDLE_ID` | 允许接收通知的应用 Bundle ID | 两个 V2 入口 |
| `APP_STORE_APPLE_ID` | 应用的数字 Apple ID，也用于卡片跳转链接 | 两个 V2 入口 |
| `APPLE_ROOT_CERTIFICATES` | Apple 根证书的 JSON 数组，每项是 DER 证书的 Base64 字符串 | 两个 V2 入口 |
| `APP_DISPLAY_NAME` | 应用显示名称，默认 `App Store` | 可选 |
| `FEISHU_MESSAGE_KEYWORD` | 卡片标题前缀，默认 `App Store` | 可选 |
| `FEISHU_MENTION_USER_IDS` | 群成员 open ID 的 JSON 数组；显式填写 `all` 表示所有人 | 可选，默认 `[]` |
| `FEISHU_MENTION_EVENTS` | 触发 @ 的事件类型、状态或子类型 JSON 数组 | 可选，默认 `[]` |
| `APPLE_ENABLE_ONLINE_CHECKS` | 是否在线检查证书吊销状态，默认 `true` | 生产环境保持 `true` |

生产环境中，将凭据、私人应用名称、应用标识和成员 ID 配置为 Secrets。即使某个标识本身不是认证凭据，也不要把私人配置提交到仓库。`wrangler.jsonc` 中只保留非敏感默认值。

以下仅为 @ 提醒的虚构配置示例：

```dotenv
FEISHU_MENTION_USER_IDS='["ou_example"]'
FEISHU_MENTION_EVENTS='["REFUND","DID_FAIL_TO_RENEW","REJECTED"]'
```

事件匹配区分大小写，使用完整值。未知的 Apple 事件类型仍会生成通用卡片。Apple 提供的文本按纯文本展示，只有配置过的成员 ID 会进入 Markdown @ 标签。

### 准备 Apple 根证书

直接从 [Apple PKI](https://www.apple.com/certificateauthority/) 下载 Apple 根证书，包含当前 App Store 签名链所需的根，并独立确认文件来源。不能仅因为证书名称包含 Apple，或证书出现在 webhook 的 `x5c` 字段中，就信任它。

将下载的 DER 或 PEM 证书转换为环境变量所需的 JSON：

```sh
node scripts/apple-roots.mjs /path/to/AppleRootCA.cer /path/to/AppleRootCA-G2.cer /path/to/AppleRootCA-G3.cer
```

把完整输出保存为 `APPLE_ROOT_CERTIFICATES`。在 `.dev.vars` 中使用单引号包住 JSON。脚本会检查根证书结构和主题名称，但不能证明文件确实来自 Apple；项目不会自动下载并信任证书。

接收和验证通知**不需要 App Store API 私钥、Issuer ID 或 Key ID**。本项目不查询 Apple API 补充通知信息，因此不应向 Worker 提供这些额外凭据。

### 本地运行与验证

```sh
npm run dev
```

在另一个终端运行测试：

```sh
npm test
```

`npm test` 会先构建部署包，不上传，然后运行单元测试和真实 `workerd` 集成测试。测试使用临时本地证书密钥，拦截所有出站请求，不发送真实飞书消息，也不使用真实 `.dev.vars` 作为测试绑定。测试需要本地端口可用。

`GET /health` 是公开存活检查，不泄露凭据，也不代表外部服务可用。如果在开发模式中使用真实凭据，并提交有效 webhook，Worker 会向真实飞书群发送消息。

## 部署到 Cloudflare

以下命令均从仓库根目录执行。部署步骤会向你的 Cloudflare 账户发布 Worker；`npm test` 和 `npm run build` 只在本地验证，不部署。

### 1. 登录并确定 Worker 名称

```sh
npx wrangler login
npx wrangler whoami
```

确认 Wrangler 使用正确的 Cloudflare 账户。如需自定义名称，在首次部署前修改 `wrangler.jsonc` 的 `name`。保留 `nodejs_compat`、`DELIVERY_QUEUE` 绑定和 SQLite migration。本项目使用 **Cloudflare Workers**，不使用 Pages。

### 2. 测试并部署代码

```sh
npm test
npm run deploy
```

Wrangler 会上传代码并应用 Durable Object migration。不需要额外创建 KV namespace、Cloudflare Queue、外部数据库或 cron trigger。记录 Wrangler 输出的 HTTPS 域名，例如：

```text
https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev
```

后续示例都需要替换成你的真实域名，也可以使用已路由到该 Worker 的自定义域名。Apple 回调路径应允许服务器直接访问，不要要求交互式登录或浏览器挑战；通知来源由 Worker 自身验签。

首次部署时可以暂时没有 Secrets，`/health` 可以访问。缺失 Apple 认证配置时无法接收通知；缺失或错误的飞书配置会让已经验签的事件留在队列中等待修复，绝不会允许无签名发送。**完成 Secrets 配置后，再启用 Apple 回调。**

### 3. 配置生产 Secrets

逐条执行命令，并在交互提示中输入对应值：

```sh
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_SIGNING_SECRET
# For App Store Connect Webhooks:
npx wrangler secret put APP_STORE_CONNECT_WEBHOOK_SECRET
# For Server Notifications V2:
npx wrangler secret put APP_STORE_BUNDLE_ID
npx wrangler secret put APP_STORE_APPLE_ID
npx wrangler secret put APPLE_ROOT_CERTIFICATES
# Optional private display and mention settings:
npx wrangler secret put APP_DISPLAY_NAME
npx wrangler secret put FEISHU_MENTION_USER_IDS
```

配置 `APPLE_ROOT_CERTIFICATES` 时，粘贴 `scripts/apple-roots.mjs` 输出的完整单行 JSON，**不要带 `.dev.vars` 外层的单引号**。按准备启用的入口填齐必需变量。当前实现中，两个 V2 入口都要求配置数字 `APP_STORE_APPLE_ID`，尽管 Apple 的沙盒验签本身不要求校验该值。

每次 `wrangler secret put` 都会创建并立即部署一个新的 Worker 版本。也可以在控制台进入 **Workers & Pages → 对应 Worker → Settings → Variables and Secrets → Add**，选择 **Secret** 类型，输入名称和值后部署设置。参见 [Cloudflare Secrets 官方文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

不要把密钥放入 Wrangler 明文 `vars`。`.dev.vars` 只用于本地绑定，不会自动成为生产 Secret 配置。开发和生产应使用独立的机器人凭据。`FEISHU_MENTION_EVENTS` 等非敏感选项可以在 `wrangler.jsonc` 中配置，修改后重新部署；仓库中的默认值为 `[]`。

### 4. 检查线上 Worker

```sh
curl --fail-with-body https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/health
```

预期响应为 `{"status":"ok"}`。这只能证明 Worker 存活；还需通过下文 Apple 测试确认验签、入队、投递和真实卡片效果。在浏览器地址栏打开 webhook URL 会发送 `GET`，返回 `405` 是正常现象。

## 配置飞书自定义机器人

在目标飞书群的设置中添加「自定义机器人」，然后：

1. 开启**签名校验**，把机器人提供的密钥保存为 `FEISHU_SIGNING_SECRET`，并保存机器人设置。每次发送或重试都会生成新的时间戳和签名。
2. 将完整 webhook URL 保存为 `FEISHU_WEBHOOK_URL`。URL 中的 token 和签名密钥是不同的值，两者都需要保密。
3. 如需叠加关键词校验，关键词与 `FEISHU_MESSAGE_KEYWORD` 保持一致；该值会出现在卡片标题中。Worker 始终要求签名密钥。
4. 如需 @ 提醒，配置已有群成员的 open ID 和对应事件。自定义机器人不能查询成员 ID，也不能通过邮箱反查用户；群策略可能限制 @ 所有人。

卡片支持 URL 跳转按钮。自定义机器人不支持应用机器人的交互回调或用户查询。本项目不上传图片，也不实现消息撤回。机器人创建方式与能力范围参见[飞书自定义机器人官方文档](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)。

队列每秒最多发送一次。如果其他服务共用同一机器人，也会消耗其配额。HTTP 失败和飞书 JSON 业务错误都会触发重试。Worker 不跟随重定向，消息大小限制为 20,000 字节。

## 配置 Apple 通知

将表中的域名替换为实际部署域名。三个入口均接受 `POST`，请求头为 `Content-Type: application/json`。

| 来源 | 回调 URL |
| --- | --- |
| App Store Connect Webhooks | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store-connect` |
| Server Notifications V2 生产环境 | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store/production` |
| Server Notifications V2 沙盒环境 | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store/sandbox` |

两类 Apple 服务独立配置，启用一种不会自动启用另一种。

### Connect Webhooks：审核、构建和 TestFlight

使用具有 Account Holder、Admin 或 App Manager 角色的账户：

1. 进入 **App Store Connect → 用户和访问（Users and Access）→ 集成（Integrations）→ Webhooks**。
2. 添加 webhook，填写名称和 Worker 的 Connect 回调 URL。
3. 将 **Secret** 设置为与 `APP_STORE_CONNECT_WEBHOOK_SECRET` 完全相同的私密值。
4. 选择应用和需要订阅的事件，保存配置。
5. 打开该 webhook，点击 **Test**，检查 **Recent Deliveries** 及飞书群中的卡片。

此 Secret 由你生成并与 Apple 共享，既不是飞书签名密钥，也不是 App Store API 私钥。应使用密码学安全的随机值，不要在无关应用间复用。Connect 载荷不一定包含应用 ID，因此该入口通过独立共享密钥绑定到你的 webhook 配置。

最新菜单名称与操作参见 [Apple webhook 管理指南](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks)；如需用 API 注册，参见 [Connect API 配置指南](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)。

### Server Notifications V2：订阅与内购

先在 Cloudflare 配好 `APP_STORE_BUNDLE_ID`、`APP_STORE_APPLE_ID` 和 `APPLE_ROOT_CERTIFICATES`。应用的 Bundle ID 和数字 Apple ID 可在「App 信息」中查看，两者不能混用。保持 `APPLE_ENABLE_ONLINE_CHECKS=true`。

1. 进入 **App Store Connect → 我的 App（Apps）**，选择应用。
2. 打开 **通用（General）→ App 信息（App Information）**，找到 **App Store Server Notifications**。
3. 将 **Production Server URL** 设置为 Worker 的生产回调 URL，并选择 **Version 2**。
4. 将 **Sandbox Server URL** 设置为 Worker 的沙盒回调 URL，并选择 **Version 2**。
5. 保存两处配置。

**务必显式填写沙盒 URL。** 如果未配置沙盒 URL，Apple 会把沙盒通知发往生产 URL；本项目的生产入口会拒绝沙盒载荷。此外，项目不接受 V1、LocalTesting 或 Xcode 通知。参见 [Apple 服务端通知 URL 配置指南](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications)。

可以在应用中进行沙盒购买/订阅来触发通知，或针对相应环境调用 Apple 的 [Request a Test Notification API](https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification)，然后检查飞书卡片。测试 API 的认证在你独立的 Apple API 客户端中完成；接收通知的 Worker 不需要该客户端的 `.p8` 私钥、Issuer ID 或 Key ID。

如果应用已经把订阅通知发给其他计费后端，修改 URL 前应确定原后端如何继续接收通知。本项目只转发飞书消息，不能替代订阅权益处理。

## 部署验证与排错

对每种已启用的 Apple 服务，先确认 Apple 收到成功响应，再确认目标飞书群出现卡片。`202` 表示 Worker 已持久化接收，不表示飞书已投递成功；重复通知可能返回 `200`，但不会生成新卡片。

在 Cloudflare 控制台查看 Worker 日志，或私下运行 `npx wrangler tail`。项目自身的日志不包含载荷和密钥，但工具或账户级日志可能包含额外请求元数据，不要直接分享未经检查的日志。

| 现象 | 排查方向 |
| --- | --- |
| `404` | 检查完整回调路径和 Worker/自定义域名路由 |
| `405` | 回调必须是 Apple 的 `POST`；浏览器地址栏使用 `GET` |
| `400` / `415` | 检查原始 Apple JSON 和 `application/json` 请求头 |
| Connect 返回 `401 invalid_signature` | 检查共享密钥、`x-apple-signature`，以及代理是否改写原始请求字节 |
| V2 返回 `401 invalid_signature` | 检查 Apple 根证书、Bundle ID、数字 Apple ID、环境和原始签名载荷 |
| `503 configuration_error` | 检查 Apple 认证所需的生产 Secrets 和根证书 JSON |
| `503 verification_unavailable` | Apple OCSP 或网络暂时不可用；等待重试，保持在线校验开启 |
| `503 queue_full` | 队列积压达到 10,000；处理下游失败并检查存储/CPU 用量 |
| Apple 显示成功，但群内没有卡片 | 检查 `feishu_delivery_retry`，核对机器人 URL、签名密钥、关键词、JSON 数组选项与群 @ 策略；已接收事件仍在队列中 |
| 轮换密钥后飞书拒绝消息 | 同步更新 `FEISHU_SIGNING_SECRET`，保存两侧配置 |
| 卡片没有 @ 提醒 | 同时配置成员 ID 和事件数组；匹配区分大小写 |

不同应用或机器人使用独立的 Worker 名称、部署和 Secrets。更新已部署项目时，保留原有 migration 历史。

## 投递、隐私与运行边界

- `202` 表示持久化入队，`200` 表示已存在去重记录。无效请求返回 `4xx`；验签服务不可用、配置缺失、存储失败或队列已满返回 `503`。
- 确认接收前必须完成 Apple 验签和持久化入队。飞书配置在发送时校验，因此缺失飞书签名密钥或目标配置错误不会导致有效事件被丢弃，也不会发送无签名请求。
- 可选的交易和续费 JWS 分别验证，共享最多三秒的详情补充等待时间。验证失败时仍投递已通过外层验签的事件，省略未验证详情，并在卡片中标明详情不可用。外层签名、应用身份和环境检查不会被跳过。
- 发送失败会保留在队列中无限重试，从 4 秒开始指数退避，最长间隔一小时。新事件可能先于重试事件投递，不保证顺序。修复配置后，后续重试会使用新配置。
- 待发送队列最多 10,000 条。监控 Cloudflare 存储与 CPU 用量，以及 `feishu_delivery_retry`、`delivery_queue_recovery` 日志。持续重试时先检查机器人配置，不要为了排错记录原始载荷。
- 项目不提供公开管理或重放接口。只有可信的 Cloudflare 账户成员应能访问 Durable Object 存储和 Secrets。应用日志只包含通用事件名和重试次数；配置已关闭 invocation logging，账户级日志仍需独立检查。
- 只保存和发送筛选后的事件类型、状态、时间、商品及续费字段。原始 JWS、收据、交易 ID、原始交易 ID、账户令牌、联系信息、TestFlight 反馈正文、崩溃内容和未识别字段均被丢弃。动态个人数据不会被转存到环境变量。
- 发送成功后立即删除事件摘要；仅保留 SHA-256 事件键及过期、索引元数据 30 天，再由 alarm 清理。失败摘要一直保留到发送成功，因此需要保护存储账户。
- Connect 按有效事件 ID 去重，ID 缺失或格式不支持时使用验签后请求体的哈希。无法识别的可选字段会被省略，而不是导致有效事件整条丢弃。V2 按通知 UUID 和环境去重，拒绝签发时间早于 30 天或超过当前时间 60 秒的通知；不支持历史导入。Connect 未提供签名时间戳的消息，其重放去重窗口为 30 天。
- 飞书自定义机器人没有供此项目使用的幂等键。飞书已接收但请求超时，或飞书接收后、Worker 写入成功状态前崩溃，都可能造成重复卡片。投递采用「至少一次」，不保证「恰好一次」。
- `APPLE_ENABLE_ONLINE_CHECKS=true` 使用 Apple OCSP 校验和当前证书有效期；临时 OCSP 失败返回 `503`，允许 Apple 重试。`false` 仅用于受控离线测试，只按签发时间检查证书，不检查吊销状态；不要为了绕过网络故障在生产中关闭。
- 本项目不是订阅权益服务。退款消费信息响应、订阅状态对账和计费决策需要独立后端。收到 `CONSUMPTION_REQUEST` 卡片不等于已经调用 Apple 消费信息 API。

只有使用真实配置完成 Apple 测试，并在目标飞书群确认实际卡片后，才能认为线上联调完成。本地测试无法证明你的真实凭据、群策略、账户路由或 Apple 配置正确。

## 官方参考

- [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [管理 App Store Connect Webhooks](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks)
- [配置生产和沙盒通知 URL](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications)
- [Connect webhook 配置和解析](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)
- [Connect webhook 事件结构](https://developer.apple.com/documentation/appstoreconnectapi/webhook-events)
- [Apple 官方 Node.js 验签库](https://github.com/apple/app-store-server-library-node)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
