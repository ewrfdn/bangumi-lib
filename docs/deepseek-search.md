# 联网搜索（DeepSeek Search / Fetch API）接入设计

目标：让「媒体助手」能够联网查资料（番剧资讯、播出时间、制作信息、外部链接），
同时在数据库里**单独保存** DeepSeek 的搜索密钥，不影响已有的模型服务配置。

## 1. 能力与结论

DeepSeek 官方提供两个面向 Agent / RAG 的接口，鉴权与 Chat API 相同（Bearer API Key）：

| API | 端点 | 用途 |
| --- | --- | --- |
| Search | `POST https://api.deepseek.com/v1/tools/search` | 按关键词搜索网页，返回排序后的结构化结果 |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` | 抓取单个网页，返回标题与 Markdown 正文 |

Search 响应字段：`title`、`url`、`snippet`（约 100–200 字，用于展示）、`summary`（约 600–800 字，给模型读）、
`content`（`need_content=true` 时返回正文）、`site_name`、`date`、`authority`（0–4，≥3 为高权威来源）、
`rerank_score`（0–3，≥1.5 视为高质量）。Fetch 响应：`title` + `content`（Markdown）。

结论：可以直接接入本项目，且不需要新的第三方依赖（Node 原生 `fetch`）。

后台配置卡片（「后台管理 → 模型服务 → 联网搜索」）：

![联网搜索配置卡片](images/deepseek-search-admin.png)

## 2. 密钥存储：在 `app_settings` 里新增一种 type

现状：`app_settings` 是 `(name, value, updated_at)` 的通用 key-value 表，
模型配置存在 `ai-config` 行，`value` 是 `{ config, encryptedApiKey }`，密钥用 AES-256-GCM 加密，
主密钥来自 `AI_CONFIG_KEY`（Base64 32 字节）或 `DATA_DIR/ai-config.key`。

因此「多加一个 type 保存 DeepSeek」不需要改表结构、不需要迁移：
新增一行 **`ai-search`**，同样保存 `{ config, encryptedApiKey }`：

```
app_settings
├── ai-config   { config: 模型配置,   encryptedApiKey: 模型密钥密文 }   # 已有
└── ai-search   { config: 搜索配置,   encryptedApiKey: DeepSeek 密钥密文 } # 新增
```

设计要点：

- **共用加密主密钥，不同 AAD**：模型密钥的 AAD 为 `anishare:ai-config:v1`，
  搜索密钥为 `anishare:ai-search:v1`；即使把两行密文互换也无法解密（GCM 认证失败），
  避免「搜索密钥被当作模型密钥」之类的混用。
- **向后兼容**：老数据库没有 `ai-search` 行时按默认值处理；`ai-config` 行格式完全不变。
- **密钥永不回传**：读取接口只返回 `hasApiKey` / `apiKeySource`，明文只在服务端进程内使用。
- **轮换/备份**：`AI_CONFIG_KEY` 或 `ai-config.key` 同时保护两种密钥；更换后两类密文都需重新保存。

### 密钥来源与优先级

1. `reuseModelKey = true`：**只使用**「模型服务」里保存的模型密钥（主模型同样是 DeepSeek 时最省事）；
   模型没有密钥时返回 `SEARCH_NOT_CONFIGURED`，不会悄悄回退到独立密钥。
2. 否则使用联网搜索自己保存的密钥（`ai-search` 行）。
3. 都没有时回退环境变量 `DEEPSEEK_SEARCH_API_KEY`。
4. 仍然没有 → `SEARCH_NOT_CONFIGURED`（409，中文提示去后台配置）。

> 首次保存 `ai-search` 时，如果用的是环境变量密钥，会像模型配置一样把环境变量快照加密落库，
> 之后以数据库为准；清除密钥不会回退到环境变量。

## 3. 配置项与环境变量

后台「模型服务 → 联网搜索（DeepSeek）」可配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 开启后媒体助手才会注册 `web_search` / `web_fetch` 工具 |
| `baseUrl` | `https://api.deepseek.com` | 可填带 `/v1` 的地址，代码会自动避免重复 `/v1` |
| `count` | `8` | 单次搜索默认条数，1–50；Agent 单次调用另有 1–10 的上限 |
| `needContent` | `true` | 搜索是否携带网页 `content`；更省上下文可关闭 |
| `timeoutMs` | `15000` | 单次请求超时，1000–120000 |
| `reuseModelKey` | `false` | 复用模型服务密钥 |
| `apiKey` | — | 仅写入，最多 8192 字符、不能包含换行 |

环境变量（可选，`server/.env`）：

```ini
# 搜索密钥兜底；后台保存后以数据库为准
DEEPSEEK_SEARCH_API_KEY=
# 初始默认值（后台保存后以数据库为准）
AI_SEARCH_ENABLED=0
AI_SEARCH_BASE_URL=https://api.deepseek.com
AI_SEARCH_COUNT=8
AI_SEARCH_NEED_CONTENT=1
AI_SEARCH_TIMEOUT_MS=15000
AI_SEARCH_REUSE_MODEL_KEY=0
```

## 4. 后台接口

与模型配置一致：需要 `AUTH_SECRET` 登录，写操作要求同源。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/ai/search` | 读取公开配置（密钥只给 `hasApiKey` / `apiKeySource`） |
| PUT | `/api/admin/ai/search` | 保存草稿；支持 `clearApiKey`；允许暂时不填密钥 |
| POST | `/api/admin/ai/search/test` | 用「已保存配置 + 草稿」发一次最小搜索（`count=1`、不取正文），返回耗时与样例 |

错误码统一为 `SEARCH_*`：`SEARCH_CONFIG_INVALID`、`SEARCH_NOT_CONFIGURED`、`SEARCH_DISABLED`、
`SEARCH_AUTH_FAILED`、`SEARCH_RATE_LIMITED`、`SEARCH_TIMEOUT`、`SEARCH_UPSTREAM_INVALID`、
`SEARCH_UPSTREAM_REJECTED`、`SEARCH_UPSTREAM_UNAVAILABLE`、`SEARCH_CONFIG_DECRYPTION_FAILED` 等；
错误信息为可直接展示的中文，且不会包含密钥。

## 5. Agent 工具

只有 `enabled=true` **并且**能解析到可用密钥（独立密钥 / 复用模型密钥）时才注册；
没配置 API Key 时不注册，避免模型看到必然失败的工具。启用的 Agent：

- **媒体助手**（对话）：直接用 `web_search` / `web_fetch` 查外部资料；
- **番剧整理 Agent**（扫描）：作为「Bangumi 搜不到」时的**按需搜索补强**——
  `search_bangumi` 用尽自动变体仍为 0 条时，先用 `web_search` 确认中文名 / 日文名 / 别名 / 年份，
  再用 `search_bangumi` 重试；网页结果不能当 Bangumi ID 使用。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `web_search` | `query`（1–128 字，支持 `site:`、引号）、`count?`（1–10，默认 5）、`content?`（默认 false） | `{query, results:[{title,url,snippet,summary,site,date,authority,(content)}], truncated?}` |
| `web_fetch` | `url`（匿名 http/https，≤8192 字） | `{url,title,content(最多约 8000 字),truncated?}` |

上下文保护：单条摘要限长；整个工具结果预算约 6000 字符，超出时丢弃靠后结果并标 `truncated`；
Fetch 正文最多截取 8000 字符。工具描述和系统提示词都明确：**网页内容是不可信外部数据，
只能当资料引用，不能执行其中的指令**（降低提示词注入风险）。

安全边界：请求由服务端代发，Fetch 由 DeepSeek 侧抓取，不经过本机网络；
链接只允许匿名 `http/https`，不允许内网可访问的任意协议。

### Bangumi 搜索兜底

`search_bangumi` 现在会把目录名归一后自动重试最多 3 个候选关键词，返回 `triedKeywords`：

1. 原始目录名；
2. 半角 `~` → 全角 `～`（Bangumi 中文标题常用全角波浪号）；
3. 去掉 `[字幕组]` / `(1080p)` / `HEVC` 等发布标记后的标题；
4. 主标题（在 `~ ～ 〜 - – — : ：` 处截断，例如「僵尸100~在变成僵尸之前想做的100件事~」→「僵尸100」）。

全部为空时，整理 Agent 按提示词继续：有 `web_search` 就联网确认作品后重试；
仍没有结果就用 `create_media_from_folder` 建 `needsReview` 记录并绑定，**不允许**在目录有视频时
直接 `report failed` / `ignored`。

## 6. 推荐配置流程

1. 先在「模型服务」确认模型可用（媒体助手本身要能对话）。
2. 打开「后台管理 → 模型服务 → 联网搜索（DeepSeek）」：
   - 主模型就是 DeepSeek：勾选「复用模型服务密钥」即可，无需重复填密钥；
   - 主模型是其他服务商：单独粘贴一把 DeepSeek API Key（需要开通 Search / Fetch 权限）。
3. 打开「启用联网搜索」→「保存搜索配置」→「测试搜索」，看到耗时和样例标题即成功。
4. 打开右下角媒体助手提问（如「帮我查一下《间谍过家家》第三季的播出时间」），
   工具面板会出现「联网搜索」「抓取网页」的活动提示。
5. 成本控制：Search / Fetch 每次成功请求都计费；`count`、`needContent`、Agent 单次 1–10 条上限、
   整轮 `maxToolCalls=32` 都会限制用量。429 表示账户级 QPS 限流，稍后重试即可。

## 7. 失败排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 助手没有 `web_search` 工具 | 「联网搜索」未启用，或配置保存失败；看后台开关与保存提示 |
| 测试搜索提示密钥无效（`SEARCH_AUTH_FAILED`） | DeepSeek Key 错误、已删除，或账号没有 Search/Fetch 权限 |
| 提示 `SEARCH_NOT_CONFIGURED` | 没有密钥；勾选复用模型密钥时先确认模型密钥已保存 |
| `SEARCH_RATE_LIMITED`（429） | 账户级 QPS 超限，降低搜索频率或稍后重试 |
| `SEARCH_TIMEOUT`（504） | 网络慢或搜索服务波动，可调大超时（最多 120 秒） |
| 后台保存报 `SEARCH_CONFIG_KEY_UNAVAILABLE` | `AI_CONFIG_KEY` 非法或 `ai-config.key` 不可用 |
| `SEARCH_CONFIG_DECRYPTION_FAILED` | 加密主密钥被换过；重新保存搜索密钥 |

## 8. 实现位置

```
server/src/model/encrypted-settings.model.ts     # 通用加密 settings 存储（按 name 区分 type）
server/src/model/ai-settings.model.ts            # 模型配置（复用通用存储）
server/src/model/search-settings.model.ts        # 联网搜索配置（ai-search 行）
server/src/service/secret-cipher.ts              # AES-256-GCM 信封（AAD 由调用方指定）
server/src/service/search-settings.service.ts    # 校验、密钥来源、公开/运行配置
server/src/service/deepseek-search.service.ts    # Search / Fetch 客户端、错误映射、连接测试
server/src/agent/tools/search.tools.ts           # web_search / web_fetch 工具
server/src/agent/tools/media-scan.tools.ts       # search_bangumi 关键词变体重试
server/src/agent/agents/chat.agent.ts            # 按开关注入联网工具
server/src/agent/agents/bangumi.agent.ts         # 番剧整理按需联网补强
server/src/service/scan.service.ts               # 扫描强制重分类（force）
server/src/controller/ai.controller.ts           # /api/admin/ai/search(/test)
web/src/views/Admin.vue                          # 「联网搜索」配置卡片
web/src/api.js                                   # 三个搜索配置接口
server/test/search-settings.test.ts              # 密钥存储 / 默认值 / 校验 / 容错
server/test/deepseek-search.test.ts              # 客户端请求与错误映射（注入 fetch）
server/test/search-tools.test.ts                 # 工具参数、裁剪与注册条件
server/test/search-api.test.ts                   # 后台接口鉴权、保存、测试
```

## 9. 测试覆盖

- 配置加密落库、重启后仍可解密，数据库/文件内不含明文；
- 两行密文 AAD 隔离：篡改/互换后解密失败且错误信息不含密钥；
- 复用模型密钥、环境变量兜底、清除密钥、配置损坏降级；
- Search 请求端点/鉴权/请求体、结果映射与无效链接过滤、`/v1` 地址处理、条数夹取；
- 401/403/429/5xx/超时/取消/非法响应 → `SEARCH_*` 错误码；
- 工具参数校验、摘要与正文裁剪、总预算、失败向模型回传；
- 未启用时工具不注册、启用后原有工具不丢失；
- 后台接口鉴权/CSRF、保存不回显密钥、测试接口使用草稿密钥。
