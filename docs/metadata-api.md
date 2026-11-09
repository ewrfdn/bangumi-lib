# 单条影视元数据 API

模块位于 server/src/crawler，与 service 平行。首个可用来源为 Bangumi，支持模糊搜索、ID / 条目链接详情预览、封面链接和导入已有 media。

豆瓣预留独立配置，尚未提供来源实现；前端搜索界面和后台任务执行器后续接入。

## 配置

在 server/.env 中配置，修改后重启后端：

~~~dotenv
BANGUMI_CRAWLER_ENABLED=1
BANGUMI_CRAWLER_PROXY_URL=
BANGUMI_CRAWLER_USER_AGENT=your-id/bangumi-lib/1.0
BANGUMI_CRAWLER_TIMEOUT_MS=15000
BANGUMI_CRAWLER_OPERATION_TIMEOUT_MS=35000
BANGUMI_CRAWLER_MAX_RETRIES=1
BANGUMI_CRAWLER_MIN_INTERVAL_MS=1000
BANGUMI_CRAWLER_TOKEN=

DOUBAN_CRAWLER_ENABLED=0
DOUBAN_CRAWLER_PROXY_URL=
DOUBAN_CRAWLER_TIMEOUT_MS=20000
~~~

将 your-id 改为开发者标识；开源应用在 User-Agent 中附上项目主页。普通公开条目可不设置 Token。

每个来源独立指定 HTTP/HTTPS 代理，空值明确表示直连。独立连接池不改变全局代理，代理失败不切换直连，也不隐式采用 HTTP_PROXY / HTTPS_PROXY。Docker 中 127.0.0.1 指向容器自身，应填写容器可访问的代理地址。

单次请求超时与整个操作预算分别控制；排队和重试包含在总预算中。请求默认每来源串行，最小间隔是应用设置，不代表来源官方限额。MAX_RETRIES 不包含首次请求。

DOUBAN 还预留 USER_AGENT、OPERATION_TIMEOUT_MS、MAX_RETRIES、MIN_INTERVAL_MS、TOKEN 同名配置项；启用配置不会自动实现来源。

## 接口

沿用现有登录 Cookie 和跨站写请求检查，响应使用 Cache-Control: no-store。未配置 AUTH_SECRET 时，行为与现有影视库 API 一致。

| 接口 | 返回 |
| --- | --- |
| GET /api/metadata/sources | { items: [...] }，只展示启用且已实现的来源能力 |
| POST /api/metadata/search | { items, total, limit, offset } |
| POST /api/metadata/preview | { item: 媒体草稿 } |
| POST /api/media/:id/metadata | { item: 保存后的媒体 } |

### 搜索

POST /api/metadata/search：

~~~json
{
  "source": "bangumi",
  "keyword": "芙莉莲",
  "mediaType": "anime",
  "year": 2023,
  "limit": 5,
  "offset": 0
}
~~~

year 可省略。mediaType 默认 anime，首版 Bangumi 只提供动画类型；limit 默认 5、最大 10。每次只查询指定一页。

候选包含 source、sourceId、sourceUrl、title、originalTitle、mediaType、platform、airedOn、cover。sourceId 是外部条目 ID 字符串，与本地媒体 ID 分开。

### 详情预览

POST /api/metadata/preview：

~~~json
{ "source": "bangumi", "sourceId": "400602" }
~~~

或者：

~~~json
{ "source": "bangumi", "url": "https://bgm.tv/subject/400602" }
~~~

sourceId 和 url 必须二选一，仅支持来源的标准条目页面。解析 ID 后访问固定来源接口；调用方不能覆盖代理、请求头、Token 或任意请求目标。

预览不写数据库，不下载图片。返回的 item 使用现有 media 的 camelCase 可写字段，可用于 POST /api/media 新建记录，或导入已有媒体。外部 ID 位于 attribute.metadata.sourceId。封面字段保存远程 URL；正片话数未知时省略 episodeCount。

成功抓取后，响应 item 始终包含 dataSource 和 dataSourceUrl；例如：

~~~json
{
  "item": {
    "title": "葬送的芙莉莲",
    "dataSource": "bangumi",
    "dataSourceUrl": "https://bgm.tv/subject/400602"
  }
}
~~~

上例仅展示相关字段。dataSourceUrl 是对应番剧的来源详情页链接，cover 单独返回封面图片链接。导入媒体后，两个来源字段会保存在 data_source / data_source_url 列，并在导入响应及后续查询中以 dataSource / dataSourceUrl 返回。

### 导入已有媒体

POST /api/media/12/metadata，其中 12 是本地 media.id。正文使用预览返回的 item：

~~~js
{
  metadata: preview.item,
  mode: 'fillMissing'
}
~~~

明确覆盖部分字段：

~~~js
{
  metadata: preview.item,
  mode: 'overwrite',
  fields: ['title', 'cover', 'episodeCount', 'description']
}
~~~

fields 允许 title、cover、mediaType、season、episodeCount、description、rating、tags、airedOn、series。overwrite 必须给出非空 fields；fillMissing 可省略，表示检查全部允许字段。

fillMissing 保留已有非空值，episodeCount=0 按未知值处理。文件夹名生成的非空标题也需要明确覆盖。未获取字段不清空已有数据，默认季号 1 不视为未知。

来源身份由 Service 原子管理：dataSource、dataSourceUrl、attribute.metadata 同步写入。首次导入自动绑定；同一来源同一 ID 刷新保留本次缺失的元数据键；更换来源或条目需要 overwrite。保留 attribute 的其他本地自定义内容。

读取、合并、校验和写入位于短事务中，网络请求在事务外。不会按标题自动合并影视，也不会自动创建本地目录或视频记录。

## 扩展和错误

继承 BaseCrawler，实现 _search、_fetch、parseSourceUrl、getSourceUrl，并在 Registry 显式注册。使用基类 requestJson / requestText，返回统一媒体草稿。来源配置通过构造函数注入，子类不读取环境变量。

search(params, { signal }) 搜索候选；fetch({ sourceId } 或 { url }, { signal }) 仅获取单个条目。请求断开及应用关闭会取消进行中的请求和等待，来源配置不会出现在来源列表或媒体返回中。

错误包含 error、code，以及适用时的 source，不返回原始上游响应或凭据。来源限流时返回 Retry-After（秒）。输入无效 400，条目不存在 404，来源身份冲突 409，限流 429，禁用 503，超时 504，来源网络 / 授权 / 解析失败 502。来源授权失败与本地登录状态分开。

现有 task 仍只记录状态，不自动执行爬取。完整结构见 [爬取模块设计](crawler-design.md)，媒体字段见 [影视库 API](catalog-api.md)。
