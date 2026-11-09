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

## 4.1 变更检测的三个边界

| 变更 | 能否被 mtime 发现 |
| --- | --- |
| 目录内新增/删除/改名直接子项 | 能，父目录 mtime 变化 |
| 子目录内新增/删除/改名 | 只有该子目录的 mtime 变化，父目录不变 |
| 整个目录被删除 | **不能**，目录不会出现在 readdir 结果里 |

第三种情况靠「已知子目录 vs 当前目录项」集合差补齐，逐层递归标记 `missing`。

## 5. 分类与入库

Agent 对每个变化目录判断三种结论：

| 结论 | 动作 |
| --- | --- |
| 作品目录 | 建/复用 `media`，建 `local_media`，递归收集视频写 `local_media_video` |
| 容器目录 | 不建记录，交给子目录各自处理 |
| 忽略 | 不建记录 |

只有视频文件入库（`VIDEO_EXTS`）。字幕、封面、nfo、种子只作为判断线索。

匹配不到 Bangumi 时：用文件夹名建 `media`，`data_source` 留空，`attribute.scan = { origin: 'folder_name', needsReview: true }`，与抓到资料记录明确区分。

已存在绑定且 `media.data_source` 有值的目录：**不调 Agent**，由服务端直接做视频 diff（新增写库、消失标 `missing=1`）。

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
| `sync_local_media` | 写 | 建 local_media 并由服务端递归收集视频；消失标 missing |
| `report` | 写 | 本轮结论 |

**没有删除类工具。** 所有路径参数经库根校验，不能越界。

写工具标记为 `executionMode: 'sequential'`，其余走默认并行。单轮运行的上限：

| 限制 | 值 | 行为 |
| --- | --- | --- |
| 工具调用总次数 | 32 | 超出抛错并结束本轮 |
| 对话轮数 | 10 | `finishTurn` 返回 `end` |
| 总耗时 | 120s | 中止流并抛 `PI_TIMEOUT` |

模型只负责判断和选择；视频清单、路径解析、幂等写入都由服务端完成。目录已在 `local_media` 且影视有 `data_source` 时，扫描直接同步视频，不进入模型。AI 未启用时新目录记为 `failed`，下次扫描重试，不会被误标为已处理。

`sync_local_media` 换绑影视时，`local_media` 与 `local_media_video` 的复合外键在同一事务内一起迁移（`defer_foreign_keys`）。

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
| Bangumi 限流 | 工具返回错误文本，Agent 决定 report 失败 |

## 10. 实施顺序

1. 配置拆分 + v6 迁移 + `lib_folder` 模型与遍历器。
2. Bangumi 资源落盘服务 + `/assets` 静态路由。
3. 扫描服务接 Agent 工具与系统提示词。
4. 调度器（基类 + YAML + 热加载 + 运行记录）。
5. 接口、文档、测试补齐。
