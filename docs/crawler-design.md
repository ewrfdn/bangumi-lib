# 单条影视元数据爬取模块设计

状态：首版已实现基类、独立代理、Bangumi、搜索 / 预览 / 导入 API；使用说明见 [元数据 API](metadata-api.md)。豆瓣和后台任务执行器仍为后续扩展，无新增数据库迁移。

目标：按名称搜索少量候选，选定一个来源条目后获取资料和封面链接；支持多个来源，并为每个来源独立指定代理。首个实现为 Bangumi，豆瓣保留同一接口的扩展位置。

## 1. 与当前项目对齐

当前实际影视表是 media，没有 media_lib。对外返回结构沿用现有 Catalog Service 的 camelCase 字段，由 catalog.model.js 映射到 SQLite 的 snake_case 列。

已有 dataSource、dataSourceUrl 和 attribute，首版无需新增业务表或数据库迁移。外部条目 ID 放在 attribute.metadata.sourceId，不能占用本地 media.id。

当前 task 已有任务记录、原子领取及状态流转，但没有自动执行器。首版使用同步搜索、详情预览和明确的保存操作；任务执行作为后续接入项。

## 2. 目录及调用边界

~~~text
server/src/
├── controller/
│   └── metadata.controller.js       # HTTP 参数、响应和错误映射
├── service/
│   ├── metadata.service.js          # 来源选择、预览、导入和字段合并
│   └── catalog.service.js           # 复用现有媒体校验与保存
├── crawler/                        # 新目录，与 service 平行
│   ├── base.crawler.js              # 统一入口、参数及结果校验、请求方法
│   ├── http-client.js               # 每实例独立代理、超时、取消、重试
│   ├── crawler-error.js             # 与 HTTP 框架无关的统一错误
│   ├── registry.js                  # source -> 实例，显式白名单注册
│   ├── contracts.js                 # JSDoc 类型与运行时结果校验
│   ├── bangumi.crawler.js           # Bangumi 搜索、详情、字段映射
│   └── douban.crawler.js            # 后续有可用访问方案后再实现
└── model/
    └── catalog.model.js            # 继续负责 SQL
~~~

~~~mermaid
flowchart LR
    Controller --> MetadataService
    MetadataService --> Registry
    Registry --> BangumiCrawler
    Registry --> DoubanCrawler
    BangumiCrawler --> BaseCrawler
    DoubanCrawler --> BaseCrawler
    BaseCrawler --> HttpClient
    MetadataService --> CatalogService
    CatalogService --> CatalogModel
    CatalogModel --> SQLite
~~~

Crawler 只负责来源访问、解析与字段归一化。数据库保存、与本地目录的关联和覆盖规则放在 Service。app.js 创建各来源实例并注入 Metadata Service；停止应用时关闭其连接池。

保持当前 ESM JavaScript 风格，使用 JSDoc 描述契约，无需为这个模块引入 TypeScript 或通用插件框架。

## 3. 基类的统一接口

所有来源继承 BaseCrawler，公开方法一致：

~~~js
const crawler = new BangumiCrawler(sourceConfig)

const candidates = await crawler.search({
  keyword: '葬送的芙莉莲',
  mediaType: 'anime',
  year: 2023,             // 可选，按来源能力筛选
  limit: 5,
  offset: 0,
}, { signal })

const media = await crawler.fetch({
  sourceId: '400602',
}, { signal })

// 也接受来源页面链接，与 sourceId 二选一
await crawler.fetch({
  url: 'https://bgm.tv/subject/400602',
}, { signal })

await crawler.close()
~~~

sourceId 统一为字符串，不假设所有来源使用数字。输入中的 source 是 Registry 的选择参数，不重复传给已经选定的实例。signal 为 AbortSignal，不进入 JSON 请求正文。

search 默认 mediaType='anime'、limit=5、offset=0；keyword 必须为非空字符串，year 为可选四位年份。每次 fetch 只解析一个目标，sourceId 与 url 均缺失或同时提供时拒绝请求。

| 基类负责 | 子类负责 |
| --- | --- |
| search / fetch 参数与结果校验 | _search(params, context) |
| sourceId 与 URL 二选一检查 | _fetch(sourceId, context) |
| 来源启用状态和能力检查 | parseSourceUrl(url)，仅解析该来源合法页面 |
| requestJson / requestText 统一请求入口 | getSourceUrl(sourceId)，构造规范来源页链接 |
| 独立代理、取消、超时、有限重试 | API 路径、读取所需请求头、JSON / HTML 解析 |
| 来源 URL 和跳转目标限制 | 来源字段到统一媒体字段的转换 |
| 日志脱敏、错误包装、close | 支持的媒体类型和筛选能力声明 |

search / fetch 是基类模板方法：校验输入，调用子类钩子，再校验输出。子类通过继承的 requestJson / requestText 发请求，不自行创建全局代理。

统一参数校验不依赖 Fastify，也不导入 service 层校验器。CrawlerError 由 Controller 映射成 HTTP 错误，避免 crawler 反向依赖 Controller 或 Service。

每个来源声明 id、displayName、mediaTypes、supportsYearFilter 等能力。不支持的筛选参数应明确报错，不能静默忽略。搜索返回的是候选，不做自动选中或跨来源合并。

## 4. 搜索结果契约

~~~js
{
  items: [{
    source: 'bangumi',
    sourceId: '400602',
    sourceUrl: 'https://bgm.tv/subject/400602',
    title: '葬送的芙莉莲',
    originalTitle: '葬送のフリーレン',
    mediaType: 'anime',
    platform: 'TV',
    airedOn: '2023-09-29',
    cover: 'https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg'
  }],
  total: 5,
  limit: 5,
  offset: 0
}
~~~

total 为来源能够提供的总数；无法确定时为 null，不能把本页数量伪装成总数。候选缺少日期、封面等展示字段时可以返回 null。

默认 limit=5，统一上限 10，每次只请求用户指定的一页。若某来源不支持 offset，则在能力中声明并拒绝非零 offset，不用后台全量抓取模拟分页。

## 5. 详情直接返回可入库的媒体草稿

fetch 成功时直接返回现有 media 可写字段，不再套一层来源原始数据：

~~~js
{
  title: '葬送的芙莉莲',
  mediaType: 'anime',
  cover: 'https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg',
  episodeCount: 28,
  description: '来源提供的简介',
  tags: ['奇幻'],
  airedOn: '2023-09-29',
  dataSource: 'bangumi',
  dataSourceUrl: 'https://bgm.tv/subject/400602',
  attribute: {
    metadata: {
      source: 'bangumi',
      sourceId: '400602',
      originalTitle: '葬送のフリーレン',
      aliases: [],
      platform: 'TV',
      fetchedAt: 1793808000000
    }
  }
}
~~~

示例仅说明结构；简介、标签和 fetchedAt 由本次实际请求生成。rating 在有有效评分时按 0–10 返回。

规则：

- 必须有 title、dataSource、dataSourceUrl、attribute.metadata.source 和 sourceId；原名可作为中文标题为空时的回退。
- 爬取模块的 dataSource 使用稳定来源键 bangumi / douban，展示名由 Registry 提供。已有手工录入的来源名称保持原值。
- 外部未知字段省略，不返回 undefined，不用 null、空字符串、0 或空数组冒充已获取的数据。真实空集合需要子类依据来源语义明确处理。
- season、series 没有可靠来源时省略；不能根据 API 缺失值把所有续作推断成第一季。
- episodeCount 表示来源声明的正片话数。未知则省略；章节列表只能代表已录入章节，不能保证等于最终总话数。
- 不包含本地 id、createdAt、updatedAt、localMediaId、文件路径或本地视频记录。
- attribute.metadata 是爬取模块保留空间。额外字段按需提取，不保存整份原始响应、请求头、Cookie、Token 或代理配置。
- contracts.js 负责归一化结构及边界检查，最终入库仍经过 Catalog Service 的现有校验。

现有约束包括简介最多 20,000 字符、标签最多 100 个且单项最多 64 字符、attribute JSON 最大 64 KB。超限可裁剪的文本和展示列表按固定规则裁剪并记录警告；关键标识或结果结构无效时返回 INVALID_RESULT，不能静默删除来源身份。

## 6. 每个来源独立配置代理

配置由 config.js 从服务端环境变量读取，再分别传给来源构造函数。来源类本身不读取 process.env。

~~~js
{
  bangumi: {
    enabled: true,
    proxyUrl: null,                 // null 明确代表直连
    userAgent: 'your-id/bangumi-lib/1.0',
    timeoutMs: 15000,
    maxRetries: 1,                  // 首次失败后最多再尝试一次
    minIntervalMs: 1000,
    concurrency: 1
  },
  douban: {
    enabled: false,
    proxyUrl: 'http://127.0.0.1:7890',
    timeoutMs: 20000,
    maxRetries: 0,
    minIntervalMs: 2000,
    concurrency: 1
  }
}
~~~

上述间隔是应用建议初值，不代表来源官方限额。sourceConfig 是实例级配置，两个来源可使用不同代理，也可一个走代理、一个直连。

环境变量建议：

~~~dotenv
BANGUMI_CRAWLER_ENABLED=1
BANGUMI_CRAWLER_PROXY_URL=
BANGUMI_CRAWLER_USER_AGENT=your-id/bangumi-lib/1.0
BANGUMI_CRAWLER_TIMEOUT_MS=15000
BANGUMI_CRAWLER_TOKEN=

DOUBAN_CRAWLER_ENABLED=0
DOUBAN_CRAWLER_PROXY_URL=http://127.0.0.1:7890
DOUBAN_CRAWLER_TIMEOUT_MS=20000
~~~

代理和凭据只能通过服务端配置指定，搜索 / 抓取参数不能覆盖它们。配置错误在创建实例时报告；代理连接失败返回 PROXY_ERROR，不自动改为直连。日志、HTTP 响应和 task 内容均不能包含代理密码或鉴权头。

传输层显式增加与项目 Node 版本兼容并锁定的 undici 直接依赖，同时使用其 fetch 和 Agent / ProxyAgent。每个来源创建自己的 dispatcher，直连也用实例自己的 Agent；禁止调用 setGlobalDispatcher 或隐式使用系统全局代理。

首版代理契约支持 HTTP/HTTPS 代理地址。SOCKS 能力随选定的 undici 发行版本另行验证，不在首版接口承诺中混入未经测试的协议。

请求超时与用户 signal 组合，覆盖响应体读取；来源实例拥有自己的并发队列和最小请求间隔。等待队列和重试等待也必须可以取消。整个 search / fetch 操作另设总时间预算，避免重试无限延长。

仅对明确可重试的读取操作处理临时网络错误、429、502、503、504；尊重 Retry-After 并限制总等待时间。401、403、404、验证码或解析失败不自动循环重试。Bangumi 搜索虽使用 POST，但只读性质由该子类显式声明。

响应体必须消费完或取消，设置大小上限；应用停止时先取消进行中的操作，再关闭 dispatcher。首版修改配置后重启应用即可，无需动态替换连接池。

## 7. 来源实现

### BangumiCrawler

| 统一字段 / 功能 | Bangumi 映射 |
| --- | --- |
| search | POST /v0/search/subjects，type=[2]，sort=match |
| year | air_date 年度起止范围，前提是来源已声明支持 |
| fetch | GET /v0/subjects/{sourceId} |
| title | name_cn 非空时使用，否则 name |
| cover | images.large，必要时回退可用的其他尺寸 |
| episodeCount | eps 的有效正整数；不用 total_episodes 替代 |
| description | summary |
| rating | rating.total > 0 时使用有效 rating.score |
| tags | tags 中的 name，去重后限制数量 |
| airedOn | date，仅接受有效完整日期 |
| source metadata | name、infobox 中的别名、platform、来源 ID 与获取时间 |

仅接受 bgm.tv、bangumi.tv、chii.in 的合法 subject 页面链接，解析出 ID 后请求固定 api.bgm.tv 地址，不直接请求用户传入的任意 URL。规范来源页统一使用 https://bgm.tv/subject/{id}。

封面只保存 API 给出的 URL，获取详情不额外下载图片。未来若要缓存图片，单独设计受控下载功能。未知总话数不通过抓取所有章节强行推算。

### DoubanCrawler

沿用完全相同的 search / fetch 和输出契约，保留独立代理、鉴权和请求节奏。具体数据访问方式需要在实施该来源时单独核实；本设计不假设豆瓣具有可直接使用的公开 API。

未实现时不注册为可用来源；新增该来源只增加子类和显式注册项，不改 Catalog Service 的媒体结构，也不改 Bangumi 的请求逻辑。

## 8. Service、HTTP 与保存策略

建议提供：

| HTTP 接口 | 作用 |
| --- | --- |
| GET /api/metadata/sources | 返回可用来源、展示名及能力，不返回配置秘密 |
| POST /api/metadata/search | 输入 source、keyword 及筛选参数，返回候选分页 |
| POST /api/metadata/preview | 输入 source、sourceId 或 url，返回媒体草稿 |
| POST /api/media/:id/metadata | 明确导入草稿，默认仅填空，也可指定字段覆盖 |

导入接口输入为 { metadata, mode: 'fillMissing', fields: [...] }。metadata 是预览草稿，mode 缺省为 fillMissing。重新校验结构和来源链接；客户端编辑后的草稿按普通用户输入处理，不视为来源真实性证明。

fields 只能选择 title、cover、mediaType、season、episodeCount、description、rating、tags、airedOn、series，不支持任意 JSON 路径或本地系统字段。fillMissing 可以省略 fields，表示检查上述全部字段；overwrite 必须显式提供非空 fields，避免一个 mode 参数意外覆盖全部资料。fields 只控制媒体内容字段；来源身份作为单独的原子组由 Service 管理，不允许客户端拆分选择。

Metadata Service 调用 Catalog Service 完成保存。填空判断和 attribute 合并应在读取最新记录后的短事务中执行，避免读写之间丢失并发修改；网络请求不在数据库事务中执行。实现时为 Catalog Service 增加专用导入方法，复用现有校验，而不是将合并策略塞入 Model。

- fillMissing：缺失 / null / 空文本字段可填；episodeCount=0 视为未知；tags 为空可填。已有非空标题和 season=1 不自动视为占位值。
- overwrite：仅覆盖用户选定且草稿实际包含的字段；未获取到的字段不清空。要删除现有字段仍走普通编辑接口。
- attribute 保留本地自定义键。来源身份作为一组处理：dataSource、dataSourceUrl、attribute.metadata 必须匹配。每次成功导入均原子写入身份组：首次导入自动绑定，同源同 ID 刷新身份及获取时间，切换来源或条目仅允许 overwrite；即使 fields=['cover'] 也遵循这条规则。
- 对已有来源记录，仅填空模式不切换来源；不相同来源或不相同来源 ID 时，返回冲突并让调用方明确指定覆盖。旧记录缺少 attribute.metadata 时，可由受支持的 dataSourceUrl 解析身份；无法确认则要求明确覆盖。
- 同一来源、同一 ID 更新时，仅合并此次实际返回的 attribute.metadata 白名单键并更新 fetchedAt，缺失键保留。切换来源或 ID 则整体替换该保留空间，避免残留旧来源内容；两种情况都保留 attribute 的其他键，不维护多来源历史。
- 返回保存后的 media。新建媒体可继续使用现有 POST /api/media，草稿经过相同白名单与校验。

常用流程：搜索片名，显示候选，选中一条，获取预览，选择导入字段，保存到当前 media.id。绑定后按 sourceId 刷新，不重新通过片名猜测绑定关系。

只获取条目信息，不自动创建 local_media 或 local_media_video；不因标题相同而合并已有媒体。

## 9. 统一错误与取消

CrawlerError 包含 code、source、message，以及可选的 upstreamStatus、retryAfterMs、cause；message 和可序列化内容必须脱敏。

| 错误码 | 含义 |
| --- | --- |
| INVALID_INPUT / UNSUPPORTED_FILTER | 参数或筛选条件无效 |
| SOURCE_DISABLED / UNSUPPORTED_SOURCE | 来源不可用 |
| NOT_FOUND | 来源条目不存在 |
| AUTH_REQUIRED / ACCESS_DENIED | 需要授权或来源拒绝访问 |
| RATE_LIMITED | 来源限流 |
| TIMEOUT / CANCELLED | 超时或用户取消 |
| PROXY_ERROR / NETWORK_ERROR | 代理或网络失败 |
| PARSE_ERROR / INVALID_RESULT | 解析失败或结果不符合契约 |

Controller 映射到本项目 HTTP 响应，保留 source 和 code 帮助界面提示。来源解析失败必须报告失败，不能返回一个空 media 草稿并标记成功。

请求中断可通过 AbortController 传递到队列等待、重试等待和实际网络请求。保存前检查取消状态，避免取消后的网络响应触发入库。

## 10. 后续接入 task 的边界

fetch_metadata 的 payload 只存 mediaId、source、sourceId 和明确的导入策略，不存代理、Token、Cookie 或整个来源响应。任务结果只存媒体 ID、更新字段及简短摘要，满足现有 64 KB 限制。

实施执行器时必须同时解决：

1. 当前 claimNext() 领取任意类型任务。应增加类型过滤，或者由统一执行器按 type 派发，不能让 metadata 专用执行器领走下载 / 扫描任务。
2. 当前 cancel() 仅更新数据库状态。执行器必须将任务取消联动到 AbortController，且在保存前、事务内再次确认任务仍可执行。
3. 数据更新与任务成功状态应在同一短事务中提交，取消与成功竞争时只有一方生效；关闭应用时取消请求并处理遗留 running 状态。

首版不启动后台轮询，不承诺创建 task 就会开始爬取。

## 11. 实施顺序和验证

1. 定义 contracts、CrawlerError、HTTP client、BaseCrawler 和 Registry。
2. 实现 BangumiCrawler 的搜索、URL / ID 详情和字段映射。
3. 在 config.js / app.js 注入来源配置与生命周期，接入 Metadata Service、预览和导入接口。
4. 完成单条导入后，再独立实现豆瓣来源或 task 执行器。

必要验证：两个来源代理互不影响、代理失败不切直连；URL 域名与跳转限制；超时 / 取消及重试退出；搜索候选与本地 ID 不混用；未知话数不冒充总数；缺失值不清空现有字段；attribute 自定义内容保留；跨来源身份不混写。使用注入的模拟 HTTP 响应验证，不在自动化测试里反复请求外站。

## 12. 参考

- [现有数据库设计](database-design.md)
- [现有影视库 API](catalog-api.md)
- [Bangumi 官方 API](https://bangumi.github.io/api/)
- [Bangumi User-Agent 要求](https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md)
- [Bangumi 开发者协议](https://bgm.tv/about/copyright)
- [Node 22.19 fetch 与 AbortSignal](https://nodejs.org/download/release/v22.19.0/docs/api/globals.html)
- [Undici ProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)
- [Undici Dispatcher 生命周期](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md)
