<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api } from '../api'
import Icon from '../components/Icon.vue'

const tabs = [
  { id: 'media', label: '媒体库' },
  { id: 'tasks', label: '任务记录' },
  { id: 'scheduler', label: '定时任务' },
  { id: 'ai', label: '模型服务' },
]
const requestedTab = new URLSearchParams(window.location.search).get('tab')
const tab = ref(tabs.some((item) => item.id === requestedTab) ? requestedTab : 'media')

/* ---------- 模型服务 ---------- */
const loading = ref(true)
const busy = ref('')
const denied = ref(false)
const loadError = ref('')
const error = ref('')
const success = ref('')
const saved = ref(null)
const apiKey = ref('')
const clearApiKey = ref(false)
const testResult = ref(null)
const form = reactive({
  enabled: false,
  apiFormat: 'openai-completions',
  baseUrl: '',
  model: '',
  maxTokens: 2048,
  timeoutSeconds: 30,
})
const formats = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]
const formatLabel = computed(() => formats.find(item => item.value === form.apiFormat)?.label || form.apiFormat)
const keySourceLabel = computed(() => {
  if (!saved.value?.hasApiKey) return '未配置密钥'
  return saved.value.apiKeySource === 'environment' ? '密钥来自环境变量' : '已保存密钥'
})
const baseUrlPlaceholder = computed(() => form.apiFormat === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
const hasChanges = computed(() => Boolean(saved.value) && (
  apiKey.value.length > 0 || clearApiKey.value ||
  form.enabled !== Boolean(saved.value.enabled) ||
  form.apiFormat !== saved.value.apiFormat ||
  form.baseUrl !== saved.value.baseUrl ||
  form.model !== saved.value.model ||
  Number(form.maxTokens) !== Number(saved.value.maxTokens) ||
  Math.round(Number(form.timeoutSeconds) * 1000) !== Number(saved.value.timeoutMs)
))
watch(() => [form.enabled, form.apiFormat, form.baseUrl, form.model, form.maxTokens, form.timeoutSeconds, apiKey.value, clearApiKey.value], () => {
  testResult.value = null
  success.value = ''
}, { flush: 'sync' })
function applyConfig(config) {
  saved.value = config
  Object.assign(form, {
    enabled: Boolean(config.enabled),
    apiFormat: config.apiFormat || 'openai-completions',
    baseUrl: config.baseUrl || '',
    model: config.model || '',
    maxTokens: config.maxTokens ?? 2048,
    timeoutSeconds: (config.timeoutMs ?? 30000) / 1000,
  })
  apiKey.value = ''
  clearApiKey.value = false
}
async function load() {
  loading.value = true
  denied.value = false
  loadError.value = ''
  try { applyConfig((await api.aiConfig()).config) }
  catch (e) {
    if (e.status === 403 && e.data?.code === 'ADMIN_AUTH_REQUIRED') denied.value = true
    else loadError.value = e.message
  } finally { loading.value = false }
}
function draft(requireConfigured = false) {
  const baseUrl = form.baseUrl.trim()
  const model = form.model.trim()
  if (baseUrl) {
    let parsed
    try { parsed = new URL(baseUrl) } catch { throw new Error('请输入有效的 Base URL。') }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 需要使用 http 或 https。')
  } else if (form.enabled || requireConfigured) throw new Error('请填写 Base URL。')
  if (!model && (form.enabled || requireConfigured)) throw new Error('请填写模型 ID。')
  const maxTokens = Number(form.maxTokens)
  const timeoutMs = Math.round(Number(form.timeoutSeconds) * 1000)
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('最大输出 Token 数需要是大于 0 的整数。')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('超时时间需要在 1 至 120 秒之间。')
  return {
    enabled: form.enabled,
    apiFormat: form.apiFormat,
    baseUrl, model, maxTokens, timeoutMs,
    ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    ...(clearApiKey.value ? { clearApiKey: true } : {}),
  }
}
async function save() {
  if (busy.value) return
  error.value = ''
  success.value = ''
  try {
    const config = draft(false)
    busy.value = 'save'
    const response = await api.saveAiConfig(config)
    applyConfig(response.config || (await api.aiConfig()).config)
    success.value = '配置已保存。'
  } catch (e) { error.value = e.message }
  finally { busy.value = '' }
}
async function testConnection() {
  if (busy.value) return
  error.value = ''
  success.value = ''
  testResult.value = null
  try {
    const config = draft(true)
    busy.value = 'test'
    const response = await api.testAiConfig(config)
    if (!response.ok) throw new Error(response.error || '连接测试未通过。')
    testResult.value = response
  } catch (e) { error.value = e.message }
  finally { busy.value = '' }
}
function markKeyRemoval() {
  clearApiKey.value = !clearApiKey.value
  if (clearApiKey.value) apiKey.value = ''
  success.value = ''
}

/* ---------- 媒体库 ---------- */
const MEDIA_PAGE_SIZE = 20
const MEDIA_TYPE_LABELS = { anime: '番剧', movie: '电影' }
const MEDIA_SOURCE_LABELS = { bangumi: 'Bangumi', douban: '豆瓣' }
const mediaItems = ref([])
const mediaTotal = ref(0)
const mediaQuery = ref('')
const mediaType = ref('')
const mediaLoading = ref(true)
const mediaLoadingMore = ref(false)
const mediaError = ref('')
const mediaExpanded = ref(0)
const failedCovers = reactive(new Set())
const mediaLibraries = ref([])
const mediaMode = ref('db')
const diskAll = ref([])
const diskLoading = ref(false)
const diskError = ref('')
const diskLimit = ref(MEDIA_PAGE_SIZE)
const mediaTypeOptions = ref([
  { value: '', label: '全部类型' },
  { value: 'anime', label: '番剧' },
  { value: 'movie', label: '电影' },
])
let mediaTimer = null
let mediaRequest = 0

const diskFiltered = computed(() => {
  const keyword = mediaQuery.value.trim().toLowerCase()
  return diskAll.value.filter((item) => {
    if (mediaType.value && item.mediaType !== mediaType.value) return false
    return !keyword || item.name.toLowerCase().includes(keyword)
  })
})
const diskItems = computed(() => diskFiltered.value.slice(0, diskLimit.value))
const mediaCount = computed(() => (mediaMode.value === 'disk' ? diskFiltered.value.length : mediaTotal.value))

const mediaTypeLabel = (type) => MEDIA_TYPE_LABELS[type] || type || '—'
const mediaSourceLabel = (source) => MEDIA_SOURCE_LABELS[String(source || '').toLowerCase()] || source || '未知来源'
function mediaSourceId(item) {
  const value = item.attribute?.metadata?.sourceId
  return typeof value === 'string' && value ? value : ''
}
function mediaFetchedAt(item) {
  const value = item.attribute?.metadata?.fetchedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function mediaSourceUrl(item) {
  const value = item.dataSourceUrl
  if (!value) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
function mediaCover(item) {
  const cover = item.cover
  if (!cover) return ''
  if (/^https?:\/\//i.test(cover)) return cover
  if (cover.startsWith('/')) return cover
  const relative = cover.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/')
  if (cover.startsWith('bangumi/')) return `/assets/${relative}`
  return api.fileUrl(cover)
}
function mediaSeason(item) {
  const parts = []
  if (Number.isInteger(item.season) && item.season > 0) parts.push(`第 ${item.season} 季`)
  if (Number.isInteger(item.episodeCount) && item.episodeCount > 0) parts.push(`${item.episodeCount} 集`)
  return parts.length ? parts.join(' · ') : '—'
}
async function loadMediaTypes() {
  try {
    const data = await api.libraries()
    mediaLibraries.value = data.libraries || []
    const options = [
      { value: '', label: '全部类型' },
      { value: 'anime', label: '番剧' },
      { value: 'movie', label: '电影' },
    ]
    for (const library of mediaLibraries.value) {
      if (library.mediaType && !options.some((option) => option.value === library.mediaType)) {
        options.push({ value: library.mediaType, label: MEDIA_TYPE_LABELS[library.mediaType] || library.mediaType })
      }
    }
    mediaTypeOptions.value = options
  } catch { /* 媒体库类型仅用于筛选，失败时保留静态选项 */ }
}
const diskKey = (item) => `${item.libraryId}:${item.path}`
function diskCover(item) {
  return item.poster ? api.fileUrl(item.poster, item.libraryId) : ''
}
function diskTarget(item) {
  return {
    name: item.kind === 'video' ? 'watch' : 'browse',
    query: { path: item.path, library: item.libraryId },
  }
}
async function loadDiskMedia() {
  if (disposed) return
  mediaMode.value = 'disk'
  diskLoading.value = true
  diskError.value = ''
  mediaExpanded.value = 0
  try {
    if (!mediaLibraries.value.length) await loadMediaTypes()
    const libraries = mediaLibraries.value.filter((library) => library.available !== false)
    if (!libraries.length) throw new Error('没有可用的媒体库，无法读取磁盘数据。')
    const catalogs = await Promise.all(libraries.map(async (library) => {
      try {
        const data = await api.library(library.id)
        if (data.available === false) return []
        return (data.series || []).map((series) => ({
          ...series,
          mediaType: library.mediaType,
          libraryName: library.name,
        }))
      } catch { return [] }
    }))
    if (disposed) return
    diskAll.value = catalogs.flat().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    diskLimit.value = MEDIA_PAGE_SIZE
    failedCovers.clear()
  } catch (e) {
    diskAll.value = []
    diskError.value = e.message
  } finally {
    if (!disposed) diskLoading.value = false
  }
}
async function refreshMedia() {
  if (mediaMode.value === 'disk') {
    mediaMode.value = 'db'
    if (mediaQuery.value.trim() || mediaType.value) {
      try {
        const probe = await api.media({ limit: 1, offset: 0 })
        if (!probe.total) { await loadDiskMedia(); return }
      } catch { /* 交给 loadMedia 显示错误 */ }
    }
    await loadMedia()
    return
  }
  await loadMedia()
}
async function loadMedia({ append = false } = {}) {
  if (disposed) return
  if (mediaMode.value === 'disk') {
    if (append) diskLimit.value += MEDIA_PAGE_SIZE
    return
  }
  diskError.value = ''
  const requestId = ++mediaRequest
  if (append) mediaLoadingMore.value = true
  else mediaLoading.value = true
  mediaError.value = ''
  try {
    const params = { limit: MEDIA_PAGE_SIZE, offset: append ? mediaItems.value.length : 0 }
    const query = mediaQuery.value.trim()
    if (query) params.q = query
    if (mediaType.value) params.mediaType = mediaType.value
    const data = await api.media(params)
    if (requestId !== mediaRequest || disposed) return
    if (append) {
      const known = new Set(mediaItems.value.map((item) => item.id))
      mediaItems.value = [...mediaItems.value, ...data.items.filter((item) => !known.has(item.id))]
    } else {
      mediaItems.value = data.items
      failedCovers.clear()
    }
    mediaTotal.value = data.total
    if (!append && data.total === 0) {
      if (!mediaQuery.value.trim() && !mediaType.value) {
        mediaItems.value = []
        await loadDiskMedia()
      } else {
        try {
          const probe = await api.media({ limit: 1, offset: 0 })
          if (requestId !== mediaRequest || disposed) return
          if (!probe.total) await loadDiskMedia()
        } catch { /* 保留数据库无匹配状态 */ }
      }
    }
  } catch (e) {
    if (requestId === mediaRequest) mediaError.value = e.message
  } finally {
    if (!disposed && requestId === mediaRequest) {
      mediaLoading.value = false
      mediaLoadingMore.value = false
    }
  }
}
watch([mediaQuery, mediaType], () => {
  mediaExpanded.value = 0
  clearTimeout(mediaTimer)
  if (mediaMode.value === 'disk') {
    diskLimit.value = MEDIA_PAGE_SIZE
    return
  }
  mediaTimer = setTimeout(() => { void loadMedia() }, 250)
})

/* ---------- 任务记录 ---------- */
const TASK_PAGE_SIZE = 20
const TASK_MAX_LIMIT = 200
const TASK_REFRESH_MS = 4000
const TASK_STATUS = {
  queued: { label: '排队中' },
  running: { label: '运行中' },
  succeeded: { label: '成功' },
  failed: { label: '失败' },
  cancelled: { label: '已取消' },
}
const TASK_TYPES = { scan_library: '扫描媒体库' }
const taskStatusOptions = [
  { value: '', label: '全部状态' },
  { value: 'running', label: '运行中' },
  { value: 'queued', label: '排队中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]
const taskItems = ref([])
const taskTotal = ref(0)
const taskStatus = ref('')
const taskLoading = ref(true)
const taskLoadingMore = ref(false)
const taskError = ref('')
const taskNotice = ref('')
const taskBusy = ref('')
const taskExpanded = ref(0)
const taskConfirming = ref(0)
let taskTimer = null
let taskConfirmTimer = null
let taskRequest = 0
let disposed = false

const taskIsRunning = (task) => task.status === 'running'
const taskTypeLabel = (type) => TASK_TYPES[type] || type
const taskAutoRefresh = computed(() => taskItems.value.some(taskIsRunning))
const taskProgress = (task) => Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)))

function clearTaskTimer() {
  if (taskTimer) { clearTimeout(taskTimer); taskTimer = null }
}
async function loadTasks({ append = false, silent = false } = {}) {
  if (disposed) return
  clearTaskTimer()
  const requestId = ++taskRequest
  if (!silent) {
    if (append) taskLoadingMore.value = true
    else taskLoading.value = true
  }
  taskError.value = ''
  try {
    const params = { offset: append ? taskItems.value.length : 0 }
    if (append) params.limit = TASK_PAGE_SIZE
    else if (silent) params.limit = Math.min(TASK_MAX_LIMIT, Math.max(taskItems.value.length, TASK_PAGE_SIZE))
    else params.limit = TASK_PAGE_SIZE
    if (taskStatus.value) params.status = taskStatus.value
    const data = await api.tasks(params)
    if (requestId !== taskRequest) return
    if (append) {
      const known = new Set(taskItems.value.map((item) => item.id))
      taskItems.value = [...taskItems.value, ...data.items.filter((item) => !known.has(item.id))]
    } else {
      taskItems.value = data.items
    }
    taskTotal.value = data.total
  } catch (e) {
    if (requestId === taskRequest) taskError.value = e.message
  }
  finally {
    if (disposed || requestId !== taskRequest) return
    taskLoading.value = false
    taskLoadingMore.value = false
    if (!taskError.value && taskItems.value.some(taskIsRunning)) {
      taskTimer = setTimeout(() => { void loadTasks({ silent: true }) }, TASK_REFRESH_MS)
    }
  }
}
async function cancelTask(task) {
  if (taskBusy.value) return
  taskError.value = ''
  taskNotice.value = ''
  taskBusy.value = `cancel:${task.id}`
  try {
    await api.cancelTask(task.id)
    taskNotice.value = `任务 #${task.id} 已取消。`
    await loadTasks({ silent: true })
  } catch (e) { taskError.value = e.message }
  finally { taskBusy.value = '' }
}
async function removeTask(task) {
  if (taskBusy.value) return
  taskError.value = ''
  taskNotice.value = ''
  taskBusy.value = `delete:${task.id}`
  try {
    await api.deleteTask(task.id)
    taskNotice.value = `任务 #${task.id} 已删除。`
    if (taskExpanded.value === task.id) taskExpanded.value = 0
    await loadTasks({ silent: true })
  } catch (e) { taskError.value = e.message }
  finally { taskBusy.value = '' }
}
function askRemoveTask(task) {
  if (taskConfirming.value !== task.id) {
    taskConfirming.value = task.id
    clearTimeout(taskConfirmTimer)
    taskConfirmTimer = setTimeout(() => { taskConfirming.value = 0 }, 3000)
    return
  }
  clearTimeout(taskConfirmTimer)
  taskConfirming.value = 0
  void removeTask(task)
}
watch(taskStatus, () => {
  taskExpanded.value = 0
  void loadTasks()
})

const pad2 = (value) => String(value).padStart(2, '0')
function taskTime(ms, full = false) {
  if (!ms) return '—'
  const date = new Date(ms)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  const datePart = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return full ? `${date.getFullYear()}-${datePart} ${time}` : `${datePart} ${time}`
}
function taskDuration(task) {
  if (!task.startedAt) return '—'
  const end = task.finishedAt || (taskIsRunning(task) ? Date.now() : task.startedAt)
  const ms = Math.max(0, end - task.startedAt)
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
}
function taskCompact(value, max = 100) {
  if (value === null || value === undefined) return '—'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
function jsonText(value) {
  if (value === null || value === undefined) return 'null'
  return JSON.stringify(value, null, 2)
}
function taskSummary(task) {
  if (task.status === 'failed') return task.error || '执行失败'
  if (task.status === 'cancelled') return '任务已取消'
  if (task.status === 'queued') return '等待执行'
  if (task.status === 'running') return taskProgress(task) ? `进度 ${taskProgress(task)}%` : '执行中…'
  if (task.type === 'scan_library' && task.result && typeof task.result === 'object') {
    const fields = [['failed', '失败'], ['classified', '分类'], ['synced', '同步'], ['deferred', '等待'], ['visited', '访问'], ['missing', '缺失']]
    const parts = fields
      .filter(([key]) => typeof task.result[key] === 'number')
      .map(([key, label]) => `${label} ${task.result[key]}`)
    if (typeof task.result.durationMs === 'number') parts.push(`耗时 ${(task.result.durationMs / 1000).toFixed(1)} 秒`)
    if (parts.length) return parts.join(' · ')
  }
  return taskCompact(task.result)
}

/* ---------- 定时任务 ---------- */
const schedulerData = ref(null)
const schedulerLoading = ref(true)
const schedulerError = ref('')
const schedulerNotice = ref('')
const schedulerBusy = ref('')
let schedulerTimer = null
let schedulerRequest = 0
const schedulerTasks = computed(() => schedulerData.value?.tasks ?? [])
const schedulerAutoPaused = computed(() => schedulerTasks.value.length > 0 && schedulerTasks.value.every((task) => !task.enabled))
const schedulerAnyEnabled = computed(() => schedulerTasks.value.some((task) => task.enabled))
const schedulerTypeLabel = (type) => TASK_TYPES[type] || type

function clearSchedulerTimer() {
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null }
}
async function loadScheduler({ silent = false } = {}) {
  if (disposed) return
  clearSchedulerTimer()
  const requestId = ++schedulerRequest
  if (!silent) schedulerLoading.value = true
  try {
    const data = await api.schedulerTasks()
    if (requestId !== schedulerRequest) return
    schedulerData.value = data
    schedulerError.value = ''
  } catch (e) {
    if (requestId === schedulerRequest) schedulerError.value = e.message
  }
  finally {
    if (disposed || requestId !== schedulerRequest) return
    schedulerLoading.value = false
    if (!schedulerError.value && schedulerTasks.value.some((task) => task.running)) {
      schedulerTimer = setTimeout(() => { void loadScheduler({ silent: true }) }, TASK_REFRESH_MS)
    }
  }
}
async function runScheduledTask(task) {
  if (schedulerBusy.value) return
  schedulerError.value = ''
  schedulerNotice.value = ''
  schedulerBusy.value = task.type
  try {
    const response = await api.runSchedulerTask(task.type)
    schedulerNotice.value = `已触发「${schedulerTypeLabel(task.type)}」，任务 #${response.taskId} 正在后台运行。`
    await loadScheduler({ silent: true })
    await loadTasks({ silent: true })
  } catch (e) {
    schedulerError.value = e.status === 409 ? '该任务正在运行，请等待本次结束后再触发。' : e.message
  } finally { schedulerBusy.value = '' }
}
async function reloadSchedulerConfig() {
  if (schedulerBusy.value) return
  schedulerError.value = ''
  schedulerNotice.value = ''
  schedulerBusy.value = 'reload'
  try {
    await api.reloadScheduler()
    await loadScheduler({ silent: true })
    schedulerNotice.value = '已重新读取 tasks.yaml。'
  } catch (e) {
    schedulerError.value = e.status === 422 ? `配置无效：${e.data?.error || e.message}` : e.message
  } finally { schedulerBusy.value = '' }
}
function schedulerNextRun(task) {
  if (!task.enabled) return '已暂停'
  if (!task.nextRun) return '—'
  return taskTime(Date.parse(task.nextRun))
}

onMounted(() => {
  void load()
  void loadMedia()
  void loadMediaTypes()
  void loadTasks()
  void loadScheduler()
})
onBeforeUnmount(() => {
  disposed = true
  clearTaskTimer()
  clearSchedulerTimer()
  clearTimeout(mediaTimer)
  clearTimeout(taskConfirmTimer)
})
</script>

<template>
  <div class="admin-page container">
    <div class="admin-heading"><div><h1>后台管理</h1><p>媒体库、任务记录、定时任务与模型服务</p></div></div>
    <div class="admin-tabs" role="tablist" aria-label="后台管理分区">
      <button v-for="item in tabs" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button>
    </div>

    <section v-if="tab === 'ai'" class="admin-panel" role="tabpanel" aria-label="模型服务">
      <div class="section-head">
        <div><h2>模型服务</h2></div>
        <span v-if="saved && !loading" class="config-state" :class="{ enabled: saved.enabled }"><span />{{ saved.enabled ? '已启用' : '未启用' }}</span>
      </div>
      <div v-if="loading" class="admin-loading" aria-busy="true"><span class="spinner" />正在读取配置…</div>
      <section v-else-if="denied" class="access-notice"><span class="access-icon"><Icon name="shield" :size="29" /></span><h2>模型服务需要密钥登录</h2><p>请在服务端配置 <code>AUTH_SECRET</code> 并重启服务，再用该密钥登录。</p><div><router-link to="/" class="btn">返回首页</router-link><button class="btn primary" @click="load">重新检查</button></div></section>
      <div v-else-if="loadError" class="notice err" role="alert"><span>{{ loadError }}</span><button class="btn small" @click="load">重试</button></div>
      <div v-else-if="saved" class="settings-layout">
        <form class="settings-form" @submit.prevent="save">
          <fieldset :disabled="Boolean(busy)">
            <section class="settings-card">
              <div class="card-heading"><div><h2>模型连接</h2><p>配置接口地址、模型和访问密钥。</p></div><label class="toggle-label"><span>{{ form.enabled ? '启用' : '关闭' }}</span><input v-model="form.enabled" type="checkbox" role="switch" aria-label="启用模型服务" /><span class="toggle-track" aria-hidden="true" /></label></div>
              <div class="form-content">
                <div class="field"><label for="ai-protocol">API 协议</label><select id="ai-protocol" v-model="form.apiFormat"><option v-for="format in formats" :key="format.value" :value="format.value">{{ format.label }}</option></select><small>选择服务商兼容的接口协议。</small></div>
                <div class="field"><label for="ai-base-url">Base URL</label><input id="ai-base-url" v-model="form.baseUrl" type="url" :placeholder="baseUrlPlaceholder" autocomplete="off" spellcheck="false" :required="form.enabled" /><small>填写 API 根地址，无需附加 chat/completions 或 messages。</small></div>
                <div class="field"><label for="ai-model">模型 ID</label><input id="ai-model" v-model="form.model" type="text" placeholder="输入服务商提供的模型 ID" autocomplete="off" spellcheck="false" :required="form.enabled" /></div>
                <div class="field key-field"><div class="field-heading"><label for="ai-api-key">API Key</label><span class="key-status"><Icon name="shield" :size="12" />{{ keySourceLabel }}</span></div><input id="ai-api-key" v-model="apiKey" type="password" :placeholder="saved.hasApiKey ? '留空保持当前密钥' : '输入 API Key'" autocomplete="new-password" spellcheck="false" @input="clearApiKey = false" /><div class="key-help"><small>密钥仅提交给服务端，读取配置时不会返回。</small><button v-if="saved.hasApiKey" type="button" class="remove-key" :class="{ marked: clearApiKey }" @click="markKeyRemoval">{{ clearApiKey ? '撤销移除' : '移除当前密钥' }}</button></div><div v-if="clearApiKey" class="key-removal" role="status"><Icon name="close" :size="14" /><span>保存后将移除当前密钥。<template v-if="saved.apiKeySource === 'environment'">环境变量本身不会被修改。</template></span></div></div>
              </div>
            </section>
            <details class="settings-card advanced-card"><summary><span><Icon name="settings" :size="16" />高级设置</span><Icon name="chevron-right" :size="15" /></summary><div class="advanced-content"><div class="field"><label for="ai-max-tokens">最大输出 Token 数</label><input id="ai-max-tokens" v-model.number="form.maxTokens" type="number" min="1" step="1" required /><small>限制单次回复的长度。</small></div><div class="field"><label for="ai-timeout">请求超时（秒）</label><input id="ai-timeout" v-model.number="form.timeoutSeconds" type="number" min="1" max="120" step="1" required /><small>连接测试与模型请求的等待上限。</small></div></div></details>
            <div v-if="error" class="notice err" role="alert">{{ error }}</div>
            <div v-if="success" class="save-success" role="status"><Icon name="check" :size="16" />{{ success }}</div>
            <div class="form-actions"><span class="dirty-label">{{ hasChanges ? '有未保存的更改' : '当前配置已同步' }}</span><button type="button" class="btn test-button" :disabled="Boolean(busy)" @click="testConnection"><span v-if="busy === 'test'" class="spinner" /><Icon v-else name="refresh" :size="15" />{{ busy === 'test' ? '正在测试…' : '测试连接' }}</button><button type="submit" class="btn primary save-button" :disabled="Boolean(busy)"><span v-if="busy === 'save'" class="spinner" /><Icon v-else name="check" :size="15" />{{ busy === 'save' ? '正在保存…' : '保存配置' }}</button></div>
          </fieldset>
        </form>
        <aside class="settings-side">
          <section class="side-card"><h2>当前连接</h2><dl><dt>协议</dt><dd>{{ formatLabel }}</dd><dt>模型</dt><dd class="mono">{{ form.model || '未设置' }}</dd><dt>密钥</dt><dd>{{ clearApiKey ? '等待移除' : apiKey ? '等待保存新密钥' : keySourceLabel }}</dd></dl><p>测试会使用当前填写的配置，包括尚未保存的密钥。</p></section>
          <section v-if="testResult" class="side-card test-result" role="status"><div class="test-title"><Icon name="check" :size="17" /><h2>连接成功</h2></div><dl><dt>模型</dt><dd class="mono">{{ testResult.model }}</dd><dt>耗时</dt><dd>{{ Math.round(testResult.latencyMs) }} ms</dd></dl><p v-if="testResult.reply" class="model-reply">{{ testResult.reply }}</p></section>
        </aside>
      </div>
    </section>

    <section v-else-if="tab === 'tasks'" class="admin-panel" role="tabpanel" aria-label="任务记录">
      <div class="section-head">
        <div><h2>任务记录<span class="count">{{ taskTotal }}</span></h2><p>调度任务与手动触发的每次运行都会写入 task 表。</p></div>
        <div class="section-actions">
          <label class="filter"><span>状态</span><select v-model="taskStatus" aria-label="按状态筛选任务"><option v-for="option in taskStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <button type="button" class="btn small" :disabled="taskLoading" @click="loadTasks()"><span v-if="taskLoading" class="spinner tiny" /><Icon v-else name="refresh" :size="14" />刷新</button>
        </div>
      </div>
      <div v-if="taskError" class="notice err" role="alert">{{ taskError }}</div>
      <div v-if="taskNotice" class="notice ok" role="status"><Icon name="check" :size="14" />{{ taskNotice }}</div>
      <div v-if="taskLoading" class="admin-loading" aria-busy="true"><span class="spinner" />正在读取任务记录…</div>
      <div v-else-if="!taskItems.length" class="empty">
        <span class="empty-icon"><Icon name="list" :size="26" /></span>
        <h3>{{ taskStatus ? '没有该状态的任务' : '还没有任务记录' }}</h3>
        <p>{{ taskStatus ? '换一个状态筛选试试，或点击刷新重新读取。' : '在「定时任务」中手动触发，或执行媒体库扫描后，这里会显示执行状态与结果。' }}</p>
      </div>
      <template v-else>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>编号</th><th>任务类型</th><th>状态</th><th>进度</th><th>开始时间</th><th>耗时</th><th>结果</th><th class="actions-col">操作</th></tr></thead>
            <tbody v-for="task in taskItems" :key="task.id">
              <tr :class="{ 'is-expanded': taskExpanded === task.id }">
                <td class="mono id-cell">#{{ task.id }}</td>
                <td><span class="type-label">{{ taskTypeLabel(task.type) }}</span><small v-if="taskTypeLabel(task.type) !== task.type">{{ task.type }}</small></td>
                <td><span class="chip task-state" :class="`state-${task.status}`">{{ TASK_STATUS[task.status]?.label || task.status }}</span></td>
                <td>
                  <div v-if="task.status === 'running' || task.status === 'succeeded'" class="progress-cell">
                    <span class="progress-bar"><i :style="{ width: `${taskProgress(task)}%` }" /></span>
                    <em class="mono">{{ taskProgress(task) }}%</em>
                  </div>
                  <span v-else class="faint">—</span>
                </td>
                <td class="mono nowrap">{{ taskTime(task.startedAt) }}</td>
                <td class="mono nowrap">{{ taskDuration(task) }}</td>
                <td class="summary-cell" :title="taskSummary(task)">{{ taskSummary(task) }}</td>
                <td class="row-actions">
                  <button type="button" class="btn small ghost" @click="taskExpanded = taskExpanded === task.id ? 0 : task.id">{{ taskExpanded === task.id ? '收起' : '详情' }}</button>
                  <button v-if="task.status === 'queued'" type="button" class="btn small" :disabled="Boolean(taskBusy)" @click="cancelTask(task)">{{ taskBusy === `cancel:${task.id}` ? '取消中…' : '取消' }}</button>
                  <button v-else-if="task.status !== 'running'" type="button" class="btn small" :class="{ danger: taskConfirming === task.id }" :disabled="Boolean(taskBusy)" @click="askRemoveTask(task)"><Icon name="trash" :size="13" />{{ taskConfirming === task.id ? '确认删除' : '删除' }}</button>
                  <span v-else class="running-label">运行中</span>
                </td>
              </tr>
              <tr v-if="taskExpanded === task.id" class="detail-row">
                <td colspan="8">
                  <div class="detail-grid">
                    <div class="detail-block"><h3>任务参数</h3><pre>{{ jsonText(task.payload) }}</pre></div>
                    <div class="detail-block"><h3>执行结果</h3><pre>{{ jsonText(task.result) }}</pre></div>
                    <div v-if="task.error" class="detail-block error-block"><h3>错误信息</h3><pre>{{ task.error }}</pre></div>
                    <div class="detail-block detail-times"><h3>时间</h3><dl><dt>创建</dt><dd>{{ taskTime(task.createdAt, true) }}</dd><dt>开始</dt><dd>{{ taskTime(task.startedAt, true) }}</dd><dt>结束</dt><dd>{{ taskTime(task.finishedAt, true) }}</dd></dl></div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="table-foot">
          <span class="faint">已显示 {{ taskItems.length }} / {{ taskTotal }} 条</span>
          <span v-if="taskAutoRefresh" class="auto-hint"><span class="pulse" />有任务在运行，自动刷新中</span>
          <button v-if="taskItems.length < taskTotal" type="button" class="btn small" :disabled="taskLoadingMore" @click="loadTasks({ append: true })"><span v-if="taskLoadingMore" class="spinner tiny" />{{ taskLoadingMore ? '正在加载…' : '加载更多' }}</button>
        </div>
      </template>
    </section>

    <section v-else-if="tab === 'scheduler'" class="admin-panel" role="tabpanel" aria-label="定时任务">
      <div class="section-head">
        <div><h2>定时任务</h2><p v-if="schedulerData">时区 {{ schedulerData.timezone }} · 配置文件 <span class="mono">{{ schedulerData.configPath }}</span></p><p v-else>按 tasks.yaml 注册的任务，可手动触发。</p></div>
        <div class="section-actions">
          <button type="button" class="btn small" :disabled="Boolean(schedulerBusy) || schedulerLoading" @click="reloadSchedulerConfig"><span v-if="schedulerBusy === 'reload'" class="spinner tiny" /><Icon v-else name="refresh" :size="14" />重新加载配置</button>
          <button type="button" class="btn small" :disabled="schedulerLoading" @click="loadScheduler()"><Icon name="refresh" :size="14" />刷新</button>
        </div>
      </div>
      <div v-if="schedulerAutoPaused" class="scheduler-banner paused" role="status"><span class="banner-icon"><Icon name="clock" :size="17" /></span><div><strong>自动调度已暂停</strong><p>tasks.yaml 中任务均为 enabled: false，不会按 cron 自行运行；需要时在下方点击「立即运行」手动触发。</p></div></div>
      <div v-else-if="schedulerAnyEnabled" class="scheduler-banner live" role="status"><span class="banner-icon"><Icon name="clock" :size="17" /></span><div><strong>自动调度已开启</strong><p>已启用的任务会按 cron 自动运行，也可以随时手动触发。</p></div></div>
      <div v-if="schedulerError" class="notice err" role="alert">{{ schedulerError }}</div>
      <div v-if="schedulerNotice" class="notice ok" role="status"><Icon name="check" :size="14" />{{ schedulerNotice }}</div>
      <div v-if="schedulerLoading" class="admin-loading" aria-busy="true"><span class="spinner" />正在读取定时任务…</div>
      <div v-else-if="!schedulerTasks.length" class="empty"><span class="empty-icon"><Icon name="clock" :size="26" /></span><h3>没有可用的定时任务</h3><p>请检查 tasks.yaml 是否包含已在 scheduler/registry.ts 注册的任务，然后点击「重新加载配置」。</p></div>
      <template v-else>
        <div class="table-wrap">
          <table class="data-table scheduler-table">
            <thead><tr><th>任务</th><th>Cron</th><th>自动调度</th><th>下次运行</th><th>状态</th><th>参数</th><th class="actions-col">操作</th></tr></thead>
            <tbody>
              <tr v-for="task in schedulerTasks" :key="task.type">
                <td><span class="type-label">{{ schedulerTypeLabel(task.type) }}</span><small v-if="schedulerTypeLabel(task.type) !== task.type">{{ task.type }}</small></td>
                <td class="mono nowrap">{{ task.cron }}</td>
                <td><span class="chip" :class="task.enabled ? 'plan' : 'paused'">{{ task.enabled ? '按计划运行' : '仅手动' }}</span></td>
                <td class="mono nowrap">{{ schedulerNextRun(task) }}</td>
                <td><span class="chip task-state" :class="task.running ? 'state-running' : ''">{{ task.running ? '运行中' : '空闲' }}</span></td>
                <td class="summary-cell" :title="taskCompact(task.options, 300)">{{ taskCompact(task.options, 80) }}</td>
                <td class="row-actions">
                  <button type="button" class="btn small primary" :disabled="task.running || Boolean(schedulerBusy)" @click="runScheduledTask(task)"><span v-if="schedulerBusy === task.type" class="spinner tiny" /><Icon v-else-if="!task.running" name="play" :size="13" />{{ task.running ? '运行中' : schedulerBusy === task.type ? '启动中…' : '立即运行' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="scheduler-note">手动触发会立即写入一条任务记录，执行状态和结果可在「任务记录」中查看。自动调度需要把 tasks.yaml 中对应任务的 enabled 改为 true，然后重新加载配置或等待热加载。</p>
      </template>
    </section>

    <section v-else-if="tab === 'media'" class="admin-panel" role="tabpanel" aria-label="媒体库">
      <div class="section-head">
        <div><h2>媒体库<span class="count">{{ mediaCount }}</span></h2><p>优先显示 media 表里已扫描或抓取到的媒体；整张表为空时回退到磁盘扫描结果。</p></div>
        <div class="section-actions">
          <label class="search-field"><Icon name="search" :size="14" /><input v-model="mediaQuery" type="search" placeholder="搜索标题或系列" aria-label="搜索媒体标题" /></label>
          <label class="filter"><span>类型</span><select v-model="mediaType" aria-label="按媒体类型筛选"><option v-for="option in mediaTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <button type="button" class="btn small" :disabled="mediaLoading || diskLoading" @click="refreshMedia"><span v-if="mediaLoading || diskLoading" class="spinner tiny" /><Icon v-else name="refresh" :size="14" />刷新</button>
        </div>
      </div>
      <div v-if="mediaError" class="notice err" role="alert">{{ mediaError }}</div>
      <div v-if="diskError" class="notice err" role="alert">{{ diskError }}</div>
      <div v-if="mediaLoading || diskLoading" class="admin-loading" aria-busy="true"><span class="spinner" />正在读取媒体库…</div>
      <template v-else-if="mediaMode === 'disk'">
        <div class="disk-banner" role="status"><span class="banner-icon"><Icon name="folder" :size="16" /></span><div><strong>数据库暂无媒体记录</strong><p>下面显示磁盘扫描结果，这些目录还没有写入 media 表。完成扫描入库后点「刷新」即可切回数据库数据。</p></div></div>
        <div v-if="!diskFiltered.length" class="empty"><span class="empty-icon"><Icon name="folder" :size="26" /></span><h3>{{ mediaQuery.trim() || mediaType ? '没有匹配的磁盘目录' : '磁盘上也没有找到媒体' }}</h3><p>{{ mediaQuery.trim() || mediaType ? '换个关键词或类型筛选试试。' : '已配置的媒体库目录为空或不可读。' }}</p></div>
        <template v-else>
          <div class="table-wrap">
            <table class="data-table disk-table">
              <thead><tr><th>媒体</th><th>类型</th><th>视频数</th><th>媒体库</th><th class="actions-col">操作</th></tr></thead>
              <tbody>
                <tr v-for="item in diskItems" :key="diskKey(item)">
                  <td>
                    <div class="media-cell">
                      <div class="media-cover"><img v-if="diskCover(item) && !failedCovers.has(diskKey(item))" :src="diskCover(item)" :alt="item.name" loading="lazy" @error="failedCovers.add(diskKey(item))" /><span v-else class="media-initial">{{ (item.name || '?').trim().slice(0, 1) }}</span></div>
                      <div class="media-text"><strong>{{ item.name }}</strong><small class="mono">{{ item.path }}</small></div>
                    </div>
                  </td>
                  <td><span class="chip">{{ mediaTypeLabel(item.mediaType) }}</span></td>
                  <td class="mono nowrap">{{ item.kind === 'video' ? 1 : item.count }} 个</td>
                  <td>{{ item.libraryName }}</td>
                  <td class="row-actions"><router-link class="btn small ghost" :to="diskTarget(item)">{{ item.kind === 'video' ? '播放' : '浏览' }}<Icon name="chevron-right" :size="12" /></router-link></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="table-foot"><span class="faint">已显示 {{ diskItems.length }} / {{ diskFiltered.length }} 部</span><button v-if="diskItems.length < diskFiltered.length" type="button" class="btn small" @click="loadMedia({ append: true })">加载更多</button></div>
        </template>
      </template>
      <template v-else-if="mediaItems.length">
        <div class="table-wrap">
          <table class="data-table media-table">
            <thead><tr><th>媒体</th><th>类型</th><th>季 / 集</th><th>来源</th><th>抓取时间</th><th>更新时间</th><th class="actions-col">操作</th></tr></thead>
            <tbody v-for="item in mediaItems" :key="item.id">
              <tr :class="{ 'is-expanded': mediaExpanded === item.id }">
                <td>
                  <div class="media-cell">
                    <div class="media-cover"><img v-if="mediaCover(item) && !failedCovers.has(item.id)" :src="mediaCover(item)" :alt="item.title" loading="lazy" @error="failedCovers.add(item.id)" /><span v-else class="media-initial">{{ (item.title || '?').trim().slice(0, 1) }}</span></div>
                    <div class="media-text"><strong>{{ item.title }}</strong><small v-if="item.series">{{ item.series }}</small><small v-else-if="mediaSourceId(item)" class="mono">#{{ mediaSourceId(item) }}</small></div>
                  </div>
                </td>
                <td><span class="chip">{{ mediaTypeLabel(item.mediaType) }}</span></td>
                <td class="mono nowrap">{{ mediaSeason(item) }}</td>
                <td><span class="chip source-chip" :class="item.dataSource ? 'has-source' : 'local-source'">{{ item.dataSource ? mediaSourceLabel(item.dataSource) : '本地扫描' }}</span><small v-if="mediaSourceId(item)" class="mono">#{{ mediaSourceId(item) }}</small></td>
                <td class="mono nowrap">{{ taskTime(mediaFetchedAt(item)) }}</td>
                <td class="mono nowrap">{{ taskTime(item.updatedAt) }}</td>
                <td class="row-actions">
                  <a v-if="mediaSourceUrl(item)" class="btn small ghost" :href="mediaSourceUrl(item)" target="_blank" rel="noopener noreferrer">来源<Icon name="arrow-up-right" :size="12" /></a>
                  <button type="button" class="btn small ghost" @click="mediaExpanded = mediaExpanded === item.id ? 0 : item.id">{{ mediaExpanded === item.id ? '收起' : '详情' }}</button>
                </td>
              </tr>
              <tr v-if="mediaExpanded === item.id" class="detail-row">
                <td colspan="7">
                  <div class="detail-grid">
                    <div class="detail-block"><h3>简介</h3><p class="media-description">{{ item.description || '暂无简介' }}</p></div>
                    <div class="detail-block"><h3>标签</h3><div v-if="item.tags?.length" class="tag-list"><span v-for="tag in item.tags" :key="tag" class="chip">{{ tag }}</span></div><p v-else class="faint media-empty-text">暂无标签</p></div>
                    <div class="detail-block"><h3>来源信息</h3><dl class="detail-dl"><dt>数据源</dt><dd>{{ item.dataSource ? mediaSourceLabel(item.dataSource) : '本地扫描（未绑定来源）' }}</dd><dt>来源 ID</dt><dd class="mono">{{ mediaSourceId(item) || '—' }}</dd><dt>来源链接</dt><dd><a v-if="mediaSourceUrl(item)" :href="mediaSourceUrl(item)" target="_blank" rel="noopener noreferrer">{{ mediaSourceUrl(item) }}<Icon name="arrow-up-right" :size="11" /></a><span v-else>—</span></dd><dt>抓取时间</dt><dd>{{ taskTime(mediaFetchedAt(item), true) }}</dd><dt>入库时间</dt><dd>{{ taskTime(item.createdAt, true) }}</dd></dl></div>
                    <div class="detail-block"><h3>原始属性</h3><pre>{{ jsonText(item.attribute) }}</pre></div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="table-foot"><span class="faint">已显示 {{ mediaItems.length }} / {{ mediaTotal }} 条</span><button v-if="mediaItems.length < mediaTotal" type="button" class="btn small" :disabled="mediaLoadingMore" @click="loadMedia({ append: true })"><span v-if="mediaLoadingMore" class="spinner tiny" />{{ mediaLoadingMore ? '正在加载…' : '加载更多' }}</button></div>
      </template>
      <div v-else class="empty"><span class="empty-icon"><Icon name="film" :size="26" /></span><h3>{{ mediaQuery.trim() || mediaType ? '没有匹配的媒体' : '媒体库还是空的' }}</h3><p>{{ mediaQuery.trim() || mediaType ? '换个关键词或类型筛选试试。' : '数据库里没有媒体记录，磁盘回退也没有读到可用目录；请检查媒体库目录或扫描入库状态。' }}</p></div>
    </section>
  </div>
</template>

<style scoped>
.admin-page { padding: 27px 0 50px; max-width: 1260px; }
.admin-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 25px; }.admin-heading h1 { margin: 0; font-size: 23px; font-weight: 600; letter-spacing: -.5px; }.admin-heading p { margin: 9px 0 0; color: var(--text-faint); font-size: 13px; }
.admin-tabs { display: inline-flex; gap: 4px; padding: 4px; margin-bottom: 24px; border: 1px solid var(--line-strong); border-radius: 8px; background: #0f0f16; }.admin-tabs button { min-height: 30px; padding: 0 15px; border-radius: 5px; color: var(--text-faint); font-size: 12px; transition: background .15s, color .15s; }.admin-tabs button:hover { color: var(--text); background: #ffffff06; }.admin-tabs button.active { color: #d8c8ff; background: #a78bfa16; }
.admin-panel { min-width: 0; }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }.section-head > div { min-width: 0; }.section-head h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.3px; }.section-head p { margin: 8px 0 0; color: var(--text-faint); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }.section-actions { display: flex; align-items: center; gap: 8px; flex: none; }.count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 19px; padding: 0 7px; margin-left: 8px; border-radius: 10px; border: 1px solid var(--line-strong); background: #ffffff05; color: var(--text-faint); font-size: 10px; vertical-align: 2px; }
.filter { display: inline-flex; align-items: center; gap: 7px; color: var(--text-faint); font-size: 11px; }.filter select { height: 28px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line-strong); background: #0b0b11; color: var(--text); font-size: 11px; outline: none; }.filter select:focus { border-color: #a78bfa85; }
.config-state { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--text-faint); font-size: 11px; flex: none; }.config-state > span { width: 5px; height: 5px; border-radius: 50%; background: #6f6b7c; }.config-state.enabled { color: #c8b3ff; border-color: #a78bfa30; background: #a78bfa08; }.config-state.enabled > span { background: var(--accent); }
.admin-loading { display: flex; align-items: center; gap: 12px; min-height: 220px; justify-content: center; color: var(--text-faint); font-size: 13px; }
.notice.ok { color: #c5b0f5; background: #a78bfa08; border: 1px solid #a78bfa20; }
.spinner.tiny { width: 12px; height: 12px; border-width: 1.5px; }
.table-wrap { border: 1px solid var(--line-strong); border-radius: 10px; background: #101016; overflow: auto; }.data-table { width: 100%; min-width: 920px; border-collapse: collapse; font-size: 12px; }.data-table th { position: sticky; top: 0; z-index: 1; padding: 11px 13px; text-align: left; background: #14141c; border-bottom: 1px solid var(--line-strong); color: var(--text-faint); font-size: 10px; font-weight: 500; letter-spacing: .04em; white-space: nowrap; }.data-table td { padding: 11px 13px; border-bottom: 1px solid var(--line); color: var(--text-dim); vertical-align: middle; }.data-table tbody:last-of-type > tr:last-child > td { border-bottom: none; }.data-table tbody > tr:not(.detail-row):hover > td { background: #ffffff03; }.data-table .nowrap { white-space: nowrap; }.data-table .id-cell { color: var(--text-faint); font-size: 11px; }.data-table .actions-col { text-align: right; }.data-table small { display: block; margin-top: 3px; color: var(--text-faint); font-size: 9px; font-family: ui-monospace, Consolas, monospace; }.type-label { color: var(--text); }
.chip.plan { color: #c5b0f5; background: #a78bfa0c; border-color: #a78bfa25; }.chip.paused { color: var(--text-faint); }.task-state { gap: 6px; }.task-state.state-running { color: #cdbbff; border-color: #a78bfa40; background: #a78bfa10; }.task-state.state-running::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: status-pulse 1.4s ease-in-out infinite; }.task-state.state-queued { color: #e3c49c; border-color: #d9b47c30; background: #d9b47c0a; }.task-state.state-succeeded { color: #c5b0f5; border-color: #a78bfa30; background: #a78bfa0c; }.task-state.state-failed { color: #efb0b9; border-color: #e594a130; background: #e594a10a; }.task-state.state-cancelled { color: var(--text-faint); }
.progress-cell { display: flex; align-items: center; gap: 8px; min-width: 112px; }.progress-bar { position: relative; flex: 1; height: 4px; border-radius: 4px; background: #ffffff10; overflow: hidden; }.progress-bar i { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); transition: width .3s; }.progress-cell em { font-style: normal; font-size: 10px; color: var(--text-faint); min-width: 30px; text-align: right; }
.summary-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.row-actions { text-align: right; white-space: nowrap; }.row-actions .btn { margin-left: 5px; }.row-actions .btn:first-child { margin-left: 0; }.btn.danger { color: #efb0b9; border-color: #e594a140; background: #e594a110; }.running-label { color: var(--text-faint); font-size: 11px; }
.detail-row > td { padding: 0; background: #0c0c12; }.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 16px 18px; border-top: 1px solid var(--line); }.detail-block h3 { margin: 0 0 7px; font-size: 10px; font-weight: 500; color: var(--text-faint); letter-spacing: .05em; }.detail-block pre { margin: 0; max-height: 190px; overflow: auto; padding: 9px 11px; border: 1px solid var(--line); border-radius: 5px; background: #08080d; color: var(--text-dim); font: 10px/1.7 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.detail-block.error-block pre { color: #efb0b9; border-color: #e594a125; }.detail-times dl { margin: 0; display: grid; grid-template-columns: 52px 1fr; gap: 8px 10px; font-size: 11px; }.detail-times dt { color: var(--text-faint); }.detail-times dd { margin: 0; color: var(--text-dim); }
.search-field { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 5px; background: #0b0b11; color: var(--text-faint); }.search-field input { width: 150px; border: none; background: none; color: var(--text); font-size: 11px; outline: none; }.search-field input::placeholder { color: #696575; }.search-field:focus-within { border-color: #a78bfa85; }
.media-table { min-width: 1000px; }.disk-table { min-width: 720px; }.disk-banner { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; margin-bottom: 12px; border: 1px solid #a78bfa25; border-radius: 7px; background: #a78bfa07; color: #c8b8ee; font-size: 12px; line-height: 1.7; }.disk-banner .banner-icon { flex: none; color: #a78bfa; margin-top: 1px; }.disk-banner strong { display: block; color: #d8c8ff; font-weight: 500; margin-bottom: 3px; }.disk-banner p { margin: 0; color: var(--text-faint); font-size: 11px; }.media-cell { display: flex; align-items: center; gap: 11px; min-width: 220px; max-width: 360px; }.media-cover { display: grid; place-items: center; width: 38px; height: 52px; flex: none; overflow: hidden; border: 1px solid var(--line); border-radius: 5px; background: #16131f; }.media-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }.media-initial { font-size: 16px; color: #a78bfa70; }.media-text { min-width: 0; }.media-text strong { display: block; color: var(--text); font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.media-text small { margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.source-chip.has-source { color: #c5b2fa; border-color: #a78bfa30; background: #a78bfa0c; }.source-chip.local-source { color: var(--text-faint); }
.media-description { margin: 0; max-height: 190px; overflow: auto; padding: 9px 11px; border: 1px solid var(--line); border-radius: 5px; background: #08080d; color: var(--text-dim); font-size: 11px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }.media-empty-text { margin: 0; font-size: 11px; }.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }.detail-dl { margin: 0; display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px 10px; font-size: 11px; }.detail-dl dt { color: var(--text-faint); }.detail-dl dd { margin: 0; color: var(--text-dim); overflow-wrap: anywhere; }.detail-dl a { display: inline-flex; align-items: center; gap: 4px; color: #c5b2fa; }
.table-foot { display: flex; align-items: center; gap: 12px; margin-top: 12px; min-height: 30px; }.table-foot .btn { margin-left: auto; }.auto-hint { display: inline-flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 11px; }.auto-hint .pulse { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: status-pulse 1.4s ease-in-out infinite; }
@keyframes status-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
.scheduler-banner { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; margin-bottom: 16px; border-radius: 8px; border: 1px solid var(--line-strong); background: #111118; }.scheduler-banner.paused { border-color: #d9b47c30; background: #d9b47c06; }.scheduler-banner.live { border-color: #a78bfa30; background: #a78bfa08; }.banner-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 7px; border: 1px solid var(--line); color: #d9b47c; background: #ffffff04; }.scheduler-banner.live .banner-icon { color: var(--accent); }.scheduler-banner strong { display: block; font-size: 12px; font-weight: 500; color: var(--text); }.scheduler-banner.paused strong { color: #e3c49c; }.scheduler-banner p { margin: 5px 0 0; color: var(--text-faint); font-size: 11px; line-height: 1.8; }.scheduler-note { margin: 13px 0 0; color: var(--text-faint); font-size: 11px; line-height: 1.8; }
.access-notice { display: flex; flex-direction: column; align-items: center; text-align: center; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--bg-elev); padding: 55px 25px; }.access-icon { display: grid; place-items: center; width: 60px; height: 60px; border: 1px solid #a78bfa25; background: #a78bfa09; border-radius: 16px; color: var(--accent); }.access-notice h2 { font-size: 18px; font-weight: 500; margin: 23px 0 0; }.access-notice p { color: var(--text-faint); font-size: 13px; line-height: 1.9; margin: 13px 0 25px; }.access-notice code { color: var(--text-dim); font-size: 12px; }.access-notice > div { display: flex; gap: 12px; }
.settings-layout { display: grid; grid-template-columns: minmax(0,1fr) 310px; gap: 24px; align-items: start; }.settings-form { min-width: 0; }.settings-form fieldset { padding: 0; margin: 0; border: none; min-width: 0; }.settings-form fieldset:disabled { opacity: .8; }.settings-card, .side-card { border: 1px solid var(--line-strong); border-radius: 10px; background: #111117; overflow: hidden; }.settings-card { margin-bottom: 19px; }.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 21px 24px; border-bottom: 1px solid var(--line); }.card-heading h2 { margin: 0; font-size: 16px; font-weight: 500; }.card-heading p { margin: 8px 0 0; font-size: 12px; color: var(--text-faint); }.toggle-label { display: flex; align-items: center; gap: 10px; position: relative; cursor: pointer; color: var(--text-dim); font-size: 12px; }.toggle-label input { position: absolute; right: 0; opacity: 0; width: 35px; height: 22px; cursor: pointer; margin: 0; }.toggle-track { display: block; width: 35px; height: 20px; border-radius: 20px; border: 1px solid #ffffff18; background: #2a2732; pointer-events: none; position: relative; }.toggle-track::after { content: ''; width: 12px; height: 12px; position: absolute; top: 3px; left: 4px; background: #b4afc0; border-radius: 50%; transition: transform .15s, background .15s; }.toggle-label input:checked + .toggle-track { background: #8060d9; border-color: #a78bfa80; }.toggle-label input:checked + .toggle-track::after { transform: translateX(13px); background: #fff; }.toggle-label input:focus-visible + .toggle-track { outline: 2px solid var(--accent); outline-offset: 4px; }
.form-content { padding: 24px; }.field + .field { margin-top: 23px; }.field label { display: block; font-size: 12px; font-weight: 500; color: #d1cddc; margin-bottom: 9px; }.field input, .field select { width: 100%; height: 39px; border: 1px solid #ffffff1c; background: #0b0b11; color: var(--text); border-radius: 6px; padding: 0 12px; font-size: 13px; outline: none; transition: border-color .15s; }.field input:focus, .field select:focus { border-color: #a78bfa85; }.field input::placeholder { color: #696575; font-size: 12px; }.field small { display: block; color: var(--text-faint); font-size: 11px; line-height: 1.75; margin-top: 8px; }.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }.field-heading label { margin-bottom: 0; }.key-status { display: flex; align-items: center; gap: 5px; font-size: 10px; color: #9f91b5; }.key-help { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }.remove-key { padding: 0; margin-top: 9px; color: #ba93a0; font-size: 11px; white-space: nowrap; }.remove-key:hover { color: #e6a7b8; }.remove-key.marked { color: var(--accent); }.key-removal { display: flex; align-items: center; gap: 7px; padding: 9px 11px; margin-top: 11px; color: #dfb3bd; border: 1px solid #e594a120; border-radius: 5px; background: #e594a107; font-size: 11px; line-height: 1.7; }.key-removal svg { flex: none; }
.advanced-card summary { display: flex; align-items: center; justify-content: space-between; padding: 17px 24px; cursor: pointer; color: var(--text-dim); font-size: 12px; list-style: none; }.advanced-card summary::-webkit-details-marker { display: none; }.advanced-card summary > span { display: inline-flex; align-items: center; gap: 9px; }.advanced-card summary > svg { transition: transform .15s; }.advanced-card[open] summary > svg { transform: rotate(90deg); }.advanced-content { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; padding: 0 24px 24px; }.advanced-content .field { margin-top: 0; }
.form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding-top: 3px; }.dirty-label { color: var(--text-faint); font-size: 11px; margin-right: auto; }.form-actions .btn { min-height: 36px; padding: 0 15px; }.form-actions .spinner { width: 14px; height: 14px; border-width: 1.5px; }.save-button .spinner { border-top-color: #fff; }.save-success { display: flex; align-items: center; gap: 8px; color: #c5b0f5; font-size: 12px; padding: 10px 12px; background: #a78bfa08; border: 1px solid #a78bfa20; border-radius: 6px; margin-bottom: 15px; }.notice.err { margin-bottom: 15px; }
.side-card { padding: 21px; margin-bottom: 18px; }.side-card h2 { font-size: 13px; font-weight: 500; margin: 0 0 18px; }.side-card dl { display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 13px 13px; font-size: 11px; line-height: 1.7; margin: 0; }.side-card dt { color: var(--text-faint); }.side-card dd { margin: 0; color: #bfb9cc; overflow-wrap: anywhere; }.side-card > p { color: var(--text-faint); font-size: 11px; line-height: 1.9; margin: 20px 0 0; padding-top: 17px; border-top: 1px solid var(--line); }.test-result { border-color: #a78bfa35; background: #a78bfa07; }.test-title { display: flex; align-items: center; gap: 7px; color: #c7b1fa; margin-bottom: 18px; }.test-title h2 { margin: 0; }.side-card .model-reply { color: var(--text-dim); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
@media(max-width:950px) { .settings-layout { grid-template-columns: minmax(0,1fr) 260px; gap: 17px; }.side-card { padding: 17px; } }
@media(max-width:900px) { .data-table th.actions-col, .data-table td.row-actions { position: sticky; right: 0; z-index: 2; background: #121219; box-shadow: -12px 0 16px -12px #000000; }.data-table th.actions-col { z-index: 3; background: #14141c; }.data-table tbody > tr:not(.detail-row):hover > td.row-actions { background: #17171f; } }
@media(max-width:750px) { .settings-layout { grid-template-columns: 1fr; }.settings-side { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }.side-card { margin-bottom: 0; }.section-head { flex-direction: column; }.section-actions { width: 100%; justify-content: flex-end; }.detail-grid { grid-template-columns: 1fr; } }
@media(max-width:500px) { .admin-page { padding-top: 20px; }.admin-heading { margin-bottom: 20px; }.admin-heading h1 { font-size: 21px; }.admin-tabs { width: 100%; }.admin-tabs button { flex: 1; padding: 0 8px; }.card-heading { padding: 18px; }.card-heading p { font-size: 11px; }.form-content { padding: 19px 18px; }.field + .field { margin-top: 21px; }.key-help { flex-wrap: wrap; gap: 0; }.key-help small { font-size: 10px; }.remove-key { margin-top: 7px; }.key-status { font-size: 9px; }.advanced-card summary { padding: 16px 18px; }.advanced-content { padding: 0 18px 18px; gap: 15px; }.advanced-content .field label { font-size: 11px; }.advanced-content .field small { font-size: 10px; }.form-actions { flex-wrap: wrap; }.dirty-label { flex-basis: 100%; margin-bottom: 4px; }.form-actions .btn { flex: 1; }.settings-side { grid-template-columns: 1fr; gap: 15px; }.access-notice { padding: 38px 20px; }.access-notice h2 { font-size: 16px; }.access-notice p { font-size: 12px; }.section-actions { flex-wrap: wrap; }.search-field { flex: 1; }.search-field input { width: 100%; } }
</style>
