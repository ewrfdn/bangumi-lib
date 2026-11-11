# 目录扫描与定时任务设计

状态：阶段 1（扫描与变更检测）、阶段 2（Bangumi 落盘）、阶段 3（Agent 工具）、阶段 4（调度器）已实现；HTTP 接口尚未实现。

## 1. 链路

~~~text
定时任务 (cron)
  → 遍历媒体库目录树
  → lib_folder 比对 mtime / 子项数
  → 变化或新出现的目录，取一级子项列表交给 Agent
  → Agent 调工具：查本地库 / 搜 Bangumi / 落库建 media / 绑定目录 / 写视频
  → 回写扫描时间
~~~

## 2. 媒体库配置：代码写死 + 环境变量给路径

媒体库的种类和 id 由代码声明，环境变量只提供根目录。新增一种库 = 在 `LIBRARY_DEFS` 加一条，不引入动态建库。

| id | 名称 | 环境变量 | 回退 |
| --- | --- | --- | --- |
| `bangumi` | 番剧库 | `BANGUMI_LIBRARY` | `BANGUMI_ROOT` / `MEDIA_ROOT` / `~/bangumi` |
| `movie` | 电影库（未启用） | `MOVIE_LIBRARY` | 无，不配置则不存在该库 |

`MEDIA_LIBRARIES` 废弃：检测到即启动报错，避免误以为仍然生效。
`library_id` 由 `default` 迁移为 `bangumi`（`local_media`、`playback_progress` 同步迁移）。

## 3. lib_folder：只记录扫描状态

不保存分类结论（`kind` / `media_id`）。「这个目录是否已分类」通过 `local_media.folder_hash` 反查。

| 字段 | 含义 |
| --- | --- |
| `id` | 主键 |
| `parent_id` | 父目录，根目录为 NULL |
| `library_id` | 媒体库 id，代码固定 |
| `rel_path` | 相对库根，`''` 表示根，统一 `/` 分隔 |
| `name` | 目录名 |
| `depth` | 深度，根为 0 |
| `mtime_ms` | 上次观测到的目录 mtime（最后更新时间） |
| `entry_count` | 直接子项数量，兜底判断 |
| `scanned_at` | 上次扫描完成时间 |
| `status` | pending / scanned / failed / missing |
| `error` | 失败摘要 |

唯一键 `(library_id, rel_path)`。路径按原样保存，不做大小写归一（Windows 仅大小写改名会视为新目录，可接受）。

## 4. 扫描算法

**关键：不能用父目录 mtime 剪枝整棵子树。** 目录 mtime 只反映直接子项：`S` 内改名只改 `S` 的 mtime，`S` 的父目录不变。因此每一层都要 `stat` 一次（廉价），只有变化或新目录才 `readdir` 交给 Agent（昂贵）。

~~~text
walk(dir):
  st = stat(dir)                     # 失败 → status=missing，保留旧 mtime
  entries = readdir(dir)             # 排除隐藏与系统目录
  changed = 无记录 || row.mtime_ms != st.mtimeMs || row.entry_count != entries.length

  if changed:
      rows = describe(entries)       # name / dir|file / ext / size
      await onChanged({ folder, entries: rows })   # 失败 → status=failed，不更新 mtime
      upsert(row, { mtime_ms: st.mtimeMs, entry_count, scanned_at: now })
  else:
      upsert(row, { scanned_at: now })   # 只刷新扫描时间

  for child in 子目录: walk(child)
~~~

- 最大深度 10，实际值由任务配置给出。
- 忽略：`.` 开头、`@eaDir`、`#recycle`、`$RECYCLE.BIN`、`System Volume Information`、`node_modules`。
- 符号链接目录不跟随（避免环路与越界）。
- 磁盘不可用 → 根目录 `stat` 失败，整个任务失败，不写任何 mtime。
- `missing` 只用于保留记录与历史：默认列表不展示该目录及其整棵子树，传 `includeMissing` 才返回。

### 4.2 逐层归类边界

扫描是逐层的，但**只有本层直接出现视频文件（`VIDEO_EXTS`）的目录才会交给 Agent**，
绑定键就是该目录的完整相对路径：`folder_hash = sha256(libraryId + '\0' + 小写相对路径)`。

- 本层没有视频文件（只有子目录/字幕/图片）＝容器：直接标记 `scanned`，不调用模型、不建绑定；
- 子目录里出现视频时，对子目录单独归类并绑定子目录路径；
- 本层有视频、但只是样片而正片在子目录：Agent 可判 `container`，仍不绑定当前层。
- 扫描到某个目录时，会向上检查 `a`、`a/b` 等祖先路径是否已有绑定；命中则把绑定信息（作品标题、
  季度、集数、dataSource 等）作为 `ancestors` 传给 Agent——祖先绑定会递归同步视频，子目录通常是
  番外/特典/资源，Agent 不应重复绑定。

## 4.1 变更检测的三个边界

| 变更 | 能否被 mtime 发现 |
| --- | --- |
| 目录内新增/删除/改名直接子项 | 能，父目录 mtime 变化 |
| 子目录内新增/删除/改名 | 只有该子目录的 mtime 变化，父目录不变 |
| 整个目录被删除 | **不能**，目录不会出现在 readdir 结果里 |

第三种情况靠「已知子目录 vs 当前目录项」集合差补齐，逐层递归标记 `missing`。

## 5. 分类与入库

扫描器只为「本层直接有视频文件」的目录调用 Agent，Agent 对每个这样的目录判断：

| 结论 | 动作 |
| --- | --- |
| 作品目录 | 建/复用 `media`，以**当前目录**为路径建 `local_media`，递归收集视频写 `local_media_video` |
| 容器目录 | 不建记录，交给子目录各自处理（仅当本层视频只是样片/预告时出现） |
| 忽略 | 不建记录（特典、字幕组目录、纯字幕/图片目录等） |

纯容器目录（本层没有任何视频文件）不会调用 Agent，直接标记 `scanned`，由子目录出现视频时单独归类。

只有视频文件入库（`VIDEO_EXTS`）。字幕、封面、nfo、种子只作为判断线索。

匹配不到 Bangumi 时：用文件夹名建 `media`，`data_source` 留空，`attribute.scan = { origin: 'folder_name', needsReview: true }`，与抓到资料记录明确区分。

已存在绑定且 `media.data_source` 有值的目录：**不调 Agent**，由服务端直接做视频 diff（新增写库、消失标 `missing=1`）。子目录若已被祖先目录的绑定覆盖，也不再单独归类。

## 6. Bangumi 资源

~~~text
data/bangumi/<subjectId>/
  subject.json
  cover.jpg
~~~

对外 `/assets/bangumi/<subjectId>/cover.jpg`；`media.cover` 保存相对路径 `bangumi/<subjectId>/cover.jpg`。重复爬取覆盖 JSON，图片已存在且大小一致则跳过下载。

## 7. Agent 工具

| 工具 | 读/写 | 说明 |
| --- | --- | --- |
| `list_folder` | 读 | 列出相对路径的一级子项 |
| `get_folder_binding` | 读 | 该路径已绑定的 media 与视频 |
| `search_media` | 读 | 本地库搜索，避免重复创建 |
| `search_bangumi` | 读 | 关键词搜索候选 |
| `crawl_bangumi` | 写 | 抓取并存图、建/更新 media，幂等 |
| `create_media_from_folder` | 写 | 未匹配时按文件夹名建 media 并标记待确认 |
| `update_media` | 写 | 编辑白名单字段 |
| `sync_local_media` | 写 | 建 local_media 并由服务端递归收集视频；按 Bangumi 总集数自动分正片/番外；消失标 missing |
| `inspect_video` | 写 | ffprobe 读取时长/分辨率/帧数并归档到 local_media_video |
| `screenshot_video` | 写 | 截取视频中间帧并写入该视频记录 |
| `update_videos` | 写 | 批量修正视频 `video_type` / `video_index` |
| `report` | 写 | 本轮结论 |

**没有删除类工具。** 所有路径参数经库根校验，不能越界。

写工具标记为 `executionMode: 'sequential'`，其余走默认并行。单轮运行的上限：

| 限制 | 对话 Agent 默认 | 番剧整理 Agent | 行为 |
| --- | --- | --- | --- |
| 工具调用总次数 | 24 | 50 | 超出抛错并结束本轮 |
| 对话轮数 | 8 | 20 | `finishTurn` 返回 `end` |
| 总耗时 | 120s | 300s | 中止流并抛 `PI_TIMEOUT` |

番剧整理需要「搜索 → 抓取 → 绑定 → 抽查」多步，8 轮时容易在收尾前被截断；多季/多字幕组等
复杂目录更久，因此在 `BangumiAgent` 里把工具调用放宽到 50、轮数放宽到 20、超时放宽到 300s。

模型只负责判断和选择；视频清单、路径解析、幂等写入都由服务端完成。目录已在 `local_media` 且影视有 `data_source` 时，扫描直接同步视频，不进入模型。子目录如果已被**祖先目录**的绑定覆盖，也不再单独交给 Agent（祖先绑定会递归同步视频，重复绑定会让同一作品出现多条 `local_media` 和重复视频）。AI 未启用时新目录记为 `failed`，下次扫描重试，不会被误标为已处理。

`sync_local_media` 会依据媒体的 `episode_count` 自动区分正片和番外：1..总集数的整数集号、且不带 `特典/SP/PV/CM/NCOP` 等标记的是正片；其余为番外。Agent 发现自动分类不符合实际时，用 `update_videos` 批量修正；`inspect_video` / `screenshot_video` 可读取归档片源信息或补封面。

`sync_local_media` 换绑影视时，`local_media` 与 `local_media_video` 的复合外键在同一事务内一起迁移（`defer_foreign_keys`）。

### 7.1 搜索兜底与重试

- `search_bangumi` 会先用原始关键词搜索；0 条时自动重试最多 3 个归一后的变体（全角波浪号、
  去字幕组/编码标记、主标题），返回 `triedKeywords` 说明实际搜索词。
- 后台启用 DeepSeek 联网搜索且配置了可用密钥时，整理 Agent 会额外获得 `web_search` / `web_fetch`：
  Bangumi 用尽变体仍搜不到时，按提示词先联网确认作品名/别名再重试；网页结果不能当 Bangumi ID。
- 仍找不到时必须 `create_media_from_folder` 建 `needsReview` 记录并绑定，不允许在目录有视频时
  直接 `report failed` / `ignored`。
- **祖先绑定透传**：`ancestors` 非空时，Agent 先判断当前目录是不是祖先作品的番外/特典/版本；
  是就复用祖先绑定（必要时用 `get_folder_binding` + `update_videos` 修正番外/集号）并 `report`，
  **不得**再 `sync_local_media` 产生第二条绑定；确认是独立作品时 `report failed` 说明需要拆目录。
- **季度区分**：Bangumi 的续作/不同季度是独立条目（如「我们真的学不来」257369 与
  「我们真的学不来！」285130）。选条目时必须结合文件夹路径里的季标识、`airedOn` 年份，
  抓取后用 `episodeCount` 与本地集数复核；都对不上时宁可 `report failed`，不要绑错季度。
- **容器目录不绑定**：当前目录一级子项里没有视频文件、只有子目录时，`report` 为 `container`，
  不新建/绑定影视；视频由子目录单独处理，避免父目录和子目录各绑一份。
- **重试**：Agent 正常 `report` 后目录状态会写成 `scanned`，mtime 未变化时下次扫描不会重复调用模型。
  对误判/上次未识别的目录，用 `POST /api/libraries/:id/scan` 的 `{ "force": true }`（媒体助手
  `scan_library` 工具同样支持 `force`）强制重新分类所有目录。

## 8. 定时任务

~~~text
server/src/scheduler/
├── base.task.js
├── registry.js
├── manager.js
└── tasks/scan-library.task.js
server/config/tasks.yaml
~~~

~~~yaml
timezone: Asia/Shanghai
tasks:
  - type: scan_library
    cron: "0 */10 * * * *"
    enabled: true
    timeoutMs: 900000
    options: { libraryId: bangumi, maxDepth: 4 }
~~~

- 基类暴露 `type`、默认 `cron`、`timeoutMs`、`static options`，子类实现 `validate(options)` 与 `run(options, { signal })`。
- 配置文件路径来自 `TASKS_CONFIG`，默认 `server/config/tasks.yaml`；单个文件注册全部任务。
- Manager 启动时读取 YAML，未知 `type`、非法 cron、拼错的字段都直接启动失败。
- `fs.watch` 监听配置目录 + 防抖热加载：只替换 cron/参数变化的定时器，不打断正在运行的任务；无效配置保留旧调度。
- 同一任务上次未结束则跳过本次（不排队）。
- 每次运行在 `task` 表写一条记录：`type` 为任务类型，`payload` 为 options，`result` 为任务返回值，`error` 为失败摘要。
- `runNow(type)` 可手动触发一次，同样写记录、同样受重入保护。
- 关闭应用时停止定时器并 abort 运行中的任务。

## 9. 错误与重试

| 场景 | 处理 |
| --- | --- |
| 目录暂时读不到 | `status=failed`，保留旧 mtime，下轮重试 |
| 目录已删除 | `status=missing`，记录保留 |
| Agent 抛错/超时 | 不更新 mtime，下轮重试 |
| Agent 正常 report 但未识别出作品 | 目录记为 `scanned`，需 `force: true` 才会重新分类 |
| Bangumi 限流 | 工具返回错误文本，Agent 决定 report 失败 |
| Bangumi / 网络不可用 | 搜索工具报错；启用联网搜索时可用 `web_search` 确认标题，但 `crawl_bangumi` 仍需 Bangumi 可用 |
| 目录名搜不到（波浪号、副标题、发布标记） | `search_bangumi` 自动尝试归一后的关键词变体 |
| 进程重启时任务正在运行 | 启动时把残留的 `running`/`queued` 任务标记为 `failed`（「服务重启，任务中断」），重新触发即可 |

## 10. 实施顺序

1. 配置拆分 + v6 迁移 + `lib_folder` 模型与遍历器。
2. Bangumi 资源落盘服务 + `/assets` 静态路由。
3. 扫描服务接 Agent 工具与系统提示词。
4. 调度器（基类 + YAML + 热加载 + 运行记录）。
5. 接口、文档、测试补齐。
