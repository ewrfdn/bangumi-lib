<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import Hls from 'hlsjs'
import Artplayer from 'artplayer'
import { api, codecLabel, fmtSize, fmtTime, langLabel, parseEpisode, prettyTitle } from '../api'
import { getProgress, saveProgress } from '../progress'

const props = defineProps({
  path: { type: String, default: '' },
  library: { type: String, default: '' },
  t: { type: Number, default: 0 },
})
const router = useRouter()

const loading = ref(true)
const error = ref('')
const info = ref(null)
const mode = ref('direct') // direct | transcode
const hlsReady = ref(false)
const statusText = ref('')
const busy = ref('') // 转码等待提示（只在卡住/换会话时出现）
const notice = ref('')
const theater = ref(false)
const episodeKeyword = ref('')
const currentTime = ref(0)
const hasStarted = ref(false)
let generation = 0
let disposed = false
let userPaused = false
let bufferPaused = false
let eventCleanup = () => {}

const art = shallowRef(null)
const hls = shallowRef(null)
const hlsSession = ref(null)
const playerEl = ref(null)

const subs = computed(() => info.value?.subs || [])
const streams = computed(() => (info.value?.streams || []).filter((s) => s.text))
const episodes = computed(() => info.value?.episodes || [])
const visibleEpisodes = computed(() => episodes.value.map((item, index) => ({ ...item, number: parseEpisode(item.name).episode || index + 1 })).filter((item) => prettyTitle(item.name).toLowerCase().includes(episodeKeyword.value.trim().toLowerCase()) || String(item.number).includes(episodeKeyword.value.trim())))
const currentIndex = computed(() => episodes.value.findIndex((e) => e.current))
const prevEp = computed(() => (currentIndex.value > 0 ? episodes.value[currentIndex.value - 1] : null))
const nextEp = computed(() =>
  currentIndex.value >= 0 && currentIndex.value < episodes.value.length - 1 ? episodes.value[currentIndex.value + 1] : null,
)

const title = computed(() => (info.value ? prettyTitle(info.value.name) : ''))
const ep = computed(() => parseEpisode(info.value?.name || ''))
const v = computed(() => info.value?.probe?.video)
const playKey = computed(() => info.value?.playKey || props.path)
const activeLibrary = computed(() => info.value?.libraryId || props.library)
const watchTarget = (path) => ({ name: 'watch', query: { path, library: activeLibrary.value } })

/* ---------------- 播放进度 ---------------- */
let lastSaved = 0

/* ---------------- 播放器核心 ---------------- */

const dbg = () => {}

// 转码流状态
let resumeAt = 0 // 本会话期望的播放起点（源文件时间轴）
let seekTarget = 0 // 用户点/拖进度条的目标位置
let userSeek = false // 紧随其后的 seeking 是否来自用户
let userSeekNote = 0 // 用户操作前的播放位置
let seekTimer = null
let recoverTimer = null
let watchdogTimer = null
let recovering = false
let hlsInfo = null // 当前会话进度 { start, frontier, ended }
let durationTimer = null

function stopHls() {
  clearTimeout(durationTimer)
  clearTimeout(recoverTimer)
  clearInterval(watchdogTimer)
  clearTimeout(seekTimer)
  clearTimeout(markUserSeek.t)
  if (hls.value) {
    try {
      hls.value.destroy()
    } catch {}
    hls.value = null
  }
}

/** 释放当前转码会话（真正停止 ffmpeg 进程） */
function releaseSession() {
  if (hlsSession.value) {
    api.hlsStop(hlsSession.value.id)
    hlsSession.value = null
  }
}

function destroy() {
  eventCleanup()
  eventCleanup = () => {}
  stopHls()
  releaseSession()
  if (art.value) {
    try {
      art.value.destroy(false)
    } catch {}
    art.value = null
  }
}

function baseOptions(extra = {}) {
  return {
    container: playerEl.value,
    autoplay: true,
    autoSize: false,
    fullscreen: true,
    fullscreenWeb: true,
    pip: true,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    hotkey: true,
    theme: '#a78bfa',
    lang: 'zh-cn',
    volume: 0.9,
    playsInline: true,
    moreVideoAttr: { preload: 'auto' },
    subtitle: { escape: true, style: { fontSize: '26px', fontFamily: 'inherit' } },
    ...extra,
  }
}

/** 进度条时长以源文件为准（m3u8 只有已转码的片段，时长不完整） */
function fixDuration() {
  const srcDur = Number(info.value?.duration) || 0
  const a = art.value
  if (!a || !srcDur) return
  if (Math.abs((a.video.duration || 0) - srcDur) > 1) {
    try {
      a.duration = srcDur
    } catch {}
  }
  clearTimeout(durationTimer)
  durationTimer = setTimeout(fixDuration, 1200)
}

/* ---------- 缓冲区工具 ---------- */

function bufferedNear(v, t, avail = 0.5) {
  for (let i = 0; i < v.buffered.length; i++) {
    const s = v.buffered.start(i)
    const e = v.buffered.end(i)
    if (t >= s - 0.5 && t <= e && e - t > avail) return { start: s, end: e }
  }
  return null
}
function bufferedEnd(v) {
  let end = 0
  for (let i = 0; i < v.buffered.length; i++) end = Math.max(end, v.buffered.end(i))
  return end
}

/* ---------- 用户操作识别 ---------- */

/** 进度条上的鼠标/触摸操作 = 用户主动跳转，同时记下点击点对应的时间 */
function markUserSeek(ev) {
  const a = art.value
  const bar = ev?.currentTarget || document.querySelector('.art-progress')
  if (bar && a) {
    const r = bar.getBoundingClientRect()
    const x = ev?.clientX ?? ev?.touches?.[0]?.clientX ?? r.x + r.width / 2
    const ratio = Math.min(1, Math.max(0, (x - r.x) / Math.max(1, r.width)))
    const dur = Number(info.value?.duration) || a.video.duration || 0
    if (dur > 0) seekTarget = ratio * dur
  }
  userSeek = true
  userSeekNote = a ? a.video.currentTime : 0
  clearTimeout(markUserSeek.t)
  markUserSeek.t = setTimeout(() => (userSeek = false), 400)
}

/** 程序内部的静默跳转：不要当成用户 seek */
function silentSeek(t) {
  const a = art.value
  if (!a) return
  userSeek = false
  clearTimeout(markUserSeek.t)
  // 用 setSeek 让 hls.js 自己的 startPosition 跟着走，避免它把播放头拉回旧位置
  try {
    a.setSeek(t)
  } catch {}
  a.video.currentTime = t
}

/* ---------- 转码流：seek / 追流 ---------- */

function onSeeking() {
  if (mode.value !== 'transcode') return
  const a = art.value
  if (!a || !userSeek) return
  // 程序内部的静默对齐（位置与用户操作前一致）不算用户 seek
  if (Math.abs(a.video.currentTime - userSeekNote) > Math.max(3, Math.abs(seekTarget - userSeekNote) * 0.5) === false) return
  dbg('seeking →', a.video.currentTime, 'target', seekTarget)
  clearTimeout(seekTimer)
  seekTimer = setTimeout(resolveSeek, 400)
}

/**
 * 转码流跳转：
 *  - 目标在已转码范围内 → 直接静默跳转（等待转码追上）
 *  - 目标超出已转码进度 → 从目标位置新开会话
 */
async function resolveSeek() {
  const a = art.value
  if (!a) return
  const srcDur = Number(info.value?.duration) || 0
  const want = Math.min(Math.max(0, seekTarget), srcDur || Infinity)
  const infoNow = await refreshInfo()
  if (art.value !== a || disposed) return
  const frontier = infoNow?.frontier || 0
  dbg('resolveSeek want', want, 'frontier', frontier, 'buffered', bufferedEnd(a.video))
  // 目标在已转码进度之后（或回到很早以前、会话起点之前）→ 重新开会话
  const beforeStart = infoNow && infoNow.start > 0 && want < infoNow.start - 5
  if (want > frontier - 2 || beforeStart) {
    restartTranscode(Math.floor(want))
    return
  }
  silentSeek(want)
  a.video.play().catch(() => {})
}

async function refreshInfo() {
  const s = hlsSession.value
  if (!s) return null
  try {
    const next = await api.hlsInfo(s.id)
    if (hlsSession.value?.id === s.id) hlsInfo = next
  } catch {}
  return hlsInfo
}

/**
 * 播放转码流。
 * hls.js 会把播放头静默对齐到 startPosition 对应的分片（首片缓冲后），
 * 因此换会话时只要新建实例、把 startPosition 设为目标即可，不用自己“猜时间轴”。
 */
function startHls(hlsUrl, artplayer, target) {
  stopHls()
  const video = artplayer.video
  const h = new Hls({
    startPosition: Math.max(0, target || 0),
    startOnSegmentBoundary: true,
    maxBufferLength: 20,
    maxMaxBufferLength: 30,
    backBufferLength: 60,
    enableWorker: true,
    lowLatencyMode: false,
    manifestLoadingTimeOut: 30_000,
    manifestLoadingMaxRetry: 4,
    fragLoadingTimeOut: 60_000,
    fragLoadingMaxRetry: 4,
  })
  hls.value = h
  dbg('startHls', hlsUrl, 'startPosition', target)
  h.on(Hls.Events.MANIFEST_PARSED, () => {
    hlsReady.value = true
    video.play().catch(() => {})
    fixDuration()
    clearTimeout(durationTimer)
    durationTimer = setTimeout(fixDuration, 1500)
  })
  h.on(Hls.Events.LEVEL_LOADED, () => refreshInfo())
  h.on(Hls.Events.ERROR, (_e, data) => {
    dbg('hls error', data.type, data.details, 'fatal', data.fatal, 'code', data.response?.code || '')
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      h.recoverMediaError()
    } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      clearTimeout(recoverTimer)
      recoverTimer = setTimeout(() => { if (hls.value === h && !disposed) h.startLoad() }, 1500)
    } else {
      restartTranscode(video.currentTime || 0)
    }
  })
  h.attachMedia(video)
  h.loadSource(hlsUrl.split('?')[0])
}

/**
 * 换转码会话：新实例把播放头静默跳到目标位置。
 * 目标还没转出来时（新会话刚启动），先停在该位置等首片，不自动往前跑。
 */
async function restartTranscode(from) {
  const a = art.value
  const version = generation
  if (!a || recovering || disposed) return
  const target = Math.max(0, Math.floor(Number(from) || 0))
  recovering = true
  busy.value = '正在从该位置开始转码…'
  clearTimeout(recoverTimer)
  clearInterval(watchdogTimer)
  dbg('restartTranscode →', target)
  try {
    const s = await api.hlsStart(props.path, target, activeLibrary.value)
    if (art.value !== a || version !== generation || disposed) {
      api.hlsStop(s.id)
      return
    }
    if (hlsSession.value?.id !== s.id) releaseSession()
    hlsSession.value = s
    hlsInfo = { start: s.start, frontier: s.start, ended: false }
    resumeAt = target
    bufferPaused = true
    a.video.pause()
    startHls(s.m3u8, a, target)
    startWatchdog(target)
  } catch (e) {
    if (version !== generation || disposed) return
    error.value = e.message
    busy.value = ''
  } finally {
    if (version === generation) recovering = false
  }
}

/**
 * 看门狗：每秒检查一次
 *  1. 新会话还没转出目标位置 → 停在目标位置等待（不播放）
 *  2. 播放头越过已转码进度（缓冲播完）→ 暂停并等待转码追上
 *  3. 长时间追不上 → 从当前位置换会话
 *  4. 一直卡住 → 重试
 */
function startWatchdog(target) {
  clearInterval(watchdogTimer)
  let stuck = 0
  watchdogTimer = setInterval(async () => {
    const a = art.value
    if (!a) return clearInterval(watchdogTimer)
    const v = a.video
    const t = v.currentTime
    if (v.ended || (userPaused && !bufferPaused)) { busy.value = ''; return }
    const frontier = hlsInfo?.frontier || 0
    const ready = bufferedNear(v, t, 0.3)
    // 1) 目标还没转出来
    if (target > frontier + 1) {
      busy.value = `正在从 ${fmtTime(target)} 开始转码…`
      if (!v.paused && t > frontier - 3) { bufferPaused = true; v.pause() }
      if (Math.abs(t - target) > 2) silentSeek(Math.min(target, frontier > 0 ? Math.max(frontier - 1, 0) : 0))
      return
    }
    // 2) 播放头在缓冲之外（转码还没追上）
    if (!ready) {
      busy.value = '正在等待转码追赶…'
      stuck++
      if (t < (hlsInfo?.start || 0) - 2) {
        silentSeek(hlsInfo.start)
        if (!userPaused) v.play().catch(() => {})
        stuck = 0
        return
      }
      if (bufferPaused && !userPaused && t <= frontier - 3) v.play().catch(() => {})
      if (stuck > 8) {
        // 追了 8 秒还没数据 → 直接从当前位置换会话
        stuck = 0
        restartTranscode(Math.floor(t))
      }
      return
    }
    // 3) 正常播放
    stuck = 0
    busy.value = ''
    if (v.paused && bufferPaused && !userPaused) v.play().catch(() => {})
    bufferPaused = false
  }, 1000)
}

/** 记录实际播放位置（用于续播） */
function rememberProgress(options = {}) {
  const a = art.value
  if (!a || !info.value || !hasStarted.value) return
  const time = a.video.currentTime
  const duration = Number(info.value.duration) || (Number.isFinite(a.video.duration) ? a.video.duration : 0)
  if (!duration || !Number.isFinite(time)) return
  saveProgress({ libraryId: activeLibrary.value, path: playKey.value, time, duration, at: Date.now(), title: title.value, hevc: Boolean(v.value?.hevc), poster: info.value.poster, seriesPath: info.value.seriesPath, seriesTitle: info.value.seriesTitle }, options).catch(() => {})
}

function onPageHide() {
  rememberProgress({ keepalive: true })
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function addSettings(artplayer) {
  // 字幕菜单（外挂 + 内挂）
  const list = []
  for (const s of subs.value) {
    if (s.image) continue
    list.push({
      html: escapeHtml(`外挂 · ${langLabel(s.lang) || s.ext.slice(1).toUpperCase()}${s.name.includes('chs') ? ' 简体' : ''}`),
      url: api.subtitleUrl(s.path, activeLibrary.value),
      type: 'vtt',
    })
  }
  for (const s of streams.value) {
    list.push({
      html: escapeHtml(`内挂 · ${langLabel(s.language) || codecLabel(s.codec)}${s.title ? ' ' + s.title : ''}`),
      url: api.streamSubtitleUrl(props.path, s.index, activeLibrary.value),
      type: 'vtt',
    })
  }
  if (list.length) {
    artplayer.setting.add({
      html: '字幕',
      selector: [
        { html: '关闭', value: '' },
        ...list.map((s, i) => ({ html: s.html, url: s.url, value: 'sub' + i })),
      ],
      onSelect(item) {
        if (!item.value) {
          artplayer.subtitle.switch('')
          return item.html
        }
        artplayer.subtitle.switch(item.url, { name: item.html })
        return item.html
      },
    })
  }
  artplayer.setting.add({
    html: '播放方式',
    tooltip: mode.value === 'direct' ? '直链（浏览器原生解码）' : `实时转码 · ${info.value?.probe?.video ? codecLabel(info.value.probe.video.codec) + ' → H.264' : 'H.264'}`,
  })
  artplayer.setting.add({
    html: '编码',
    tooltip: fmtCodec(),
  })
}

function fmtCodec() {
  const p = info.value?.probe
  if (!p?.video) return '未知'
  return `${codecLabel(p.video.codec)} ${p.video.width}×${p.video.height} · ${codecLabel(p.audio?.[0]?.codec || '')} ${p.audio?.[0]?.channels || ''}ch`
}

function bindEvents(artplayer) {
  // 进度条上的鼠标/触摸操作 = 用户主动跳转（每个播放器只注册一次）
  const bar = artplayer.controls?.progress?.$progress || artplayer.template?.$progress || document.querySelector('.art-progress')
  if (bar) {
    bar.addEventListener('mousedown', markUserSeek, true)
    bar.addEventListener('click', markUserSeek, true)
    bar.addEventListener('touchstart', markUserSeek, { capture: true, passive: true })
  }
  const keySeek = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return
    userSeek = true
    userSeekNote = artplayer.video.currentTime
    seekTarget = userSeekNote + (event.key === 'ArrowRight' ? 5 : -5)
    clearTimeout(markUserSeek.t)
    markUserSeek.t = setTimeout(() => (userSeek = false), 600)
  }
  document.addEventListener('keydown', keySeek, true)
  artplayer.video.addEventListener('seeking', onSeeking)
  eventCleanup = () => {
    bar?.removeEventListener('mousedown', markUserSeek, true)
    bar?.removeEventListener('click', markUserSeek, true)
    bar?.removeEventListener('touchstart', markUserSeek, true)
    document.removeEventListener('keydown', keySeek, true)
    artplayer.video.removeEventListener('seeking', onSeeking)
  }
  artplayer.on('video:loadedmetadata', () => {
    // 直链续播（转码流由 hls.js 的 startPosition 负责）
    if (mode.value === 'direct' && resumeAt > 1 && artplayer.video.currentTime < 0.5) {
      artplayer.video.currentTime = resumeAt
      artplayer.notice.show = `已从 ${fmtTime(resumeAt)} 继续播放`
    }
  })
  artplayer.on('video:playing', () => {
    busy.value = ''
    hasStarted.value = true
    userPaused = false
    bufferPaused = false
  })
  artplayer.on('video:pause', () => {
    if (!bufferPaused && !recovering) userPaused = true
    rememberProgress()
  })
  artplayer.on('video:timeupdate', () => {
    const a = art.value
    if (!a) return
    currentTime.value = a.video.currentTime
    if (Date.now() - lastSaved >= 5000) {
      lastSaved = Date.now()
      rememberProgress()
    }
  })
  artplayer.on('video:ended', () => {
    rememberProgress()
    if (nextEp.value) router.replace(watchTarget(nextEp.value.path))
  })
}

async function setupDirect(startAt) {
  const version = generation
  mode.value = 'direct'
  const a = new Artplayer(baseOptions({ url: api.streamUrl(props.path, activeLibrary.value), type: detectType(info.value?.name) }))
  art.value = a
  addSettings(a)
  bindEvents(a)
  let fallenBack = false
  a.on('error', async () => {
    if (fallenBack || version !== generation || disposed || art.value !== a) return
    fallenBack = true
    const at = a.video.currentTime || startAt || 0
    destroy()
    notice.value = '已自动切换为兼容播放，正在准备视频。'
    resumeAt = at
    try {
      await setupTranscode(at, version)
    } catch (e) {
      if (version !== generation || disposed) return
      error.value = e.message
      loading.value = false
    }
  })
  a.once('video:loadedmetadata', () => {
    if (startAt > 2) a.video.currentTime = startAt
  })
}

async function setupTranscode(startAt, version = generation) {
  mode.value = 'transcode'
  resumeAt = startAt || 0
  loading.value = true
  statusText.value = '正在启动转码…'
  const session = await api.hlsStart(props.path, resumeAt, activeLibrary.value)
  if (version !== generation || disposed) { api.hlsStop(session.id); return }
  hlsSession.value = session
  hlsInfo = { start: resumeAt, frontier: resumeAt, ended: false }
  const a = new Artplayer(
    baseOptions({
      url: session.m3u8,
      type: 'm3u8',
      customType: {
        m3u8: (video, url, artplayer) => startHls(url, artplayer, resumeAt),
      },
      // 转码流用源文件时长做进度条；不接受直播模式
      duration: info.value?.duration || 0,
      live: false,
    }),
  )
  art.value = a
  addSettings(a)
  bindEvents(a)
  loading.value = false
  startWatchdog(resumeAt)
}

function detectType(name) {
  const ext = (name || '').toLowerCase().split('.').pop()
  return { mkv: 'video', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ts: 'video/mp2t', m2ts: 'video/mp2t' }[ext] || 'video/mp4'
}

/* ---------------- 生命周期 ---------------- */

async function load() {
  rememberProgress({ keepalive: true })
  const version = ++generation
  destroy()
  loading.value = true
  error.value = ''
  notice.value = ''
  busy.value = ''
  hasStarted.value = false
  userPaused = false
  bufferPaused = false
  recovering = false
  currentTime.value = 0
  info.value = null
  hlsReady.value = false
  lastSaved = 0
  statusText.value = '正在分析媒体…'
  try {
    if (!props.path) throw new Error('请先从番剧库选择一集视频。')
    const [data, progress] = await Promise.all([api.video(props.path, props.library), getProgress().catch(() => [])])
    if (version !== generation || disposed) return
    info.value = data
    const saved = progress.find((item) => item.libraryId === data.libraryId && item.path === (data.playKey || props.path))
    const fromQuery = Number.isFinite(props.t) ? Math.max(0, props.t) : 0
    const wanted = fromQuery > 0 ? fromQuery : saved && saved.time > 10 && saved.time < (data.duration || Infinity) - 30 ? saved.time : 0
    const startAt = Math.min(wanted, data.duration > 0 ? Math.max(0, data.duration - 1) : wanted)
    resumeAt = startAt
    await nextTick()
    if (version !== generation || disposed) return
    if (data.playback.directPlay) {
      await setupDirect(startAt)
      if (version === generation && !disposed) loading.value = false
    } else {
      await setupTranscode(Math.floor(startAt), version)
    }
  } catch (e) {
    if (version !== generation || disposed) return
    error.value = e.message
    loading.value = false
  }
}

onMounted(() => {
  window.addEventListener('pagehide', onPageHide)
  load()
})
watch(() => [props.path, props.library], load)
onBeforeUnmount(() => {
  rememberProgress({ keepalive: true })
  disposed = true
  generation++
  window.removeEventListener('pagehide', onPageHide)
  destroy()
})

function back() {
  if (window.history.length > 1) router.back()
  else if (info.value?.dir) router.push({ name: 'browse', query: { path: info.value.dir, library: activeLibrary.value } })
  else router.push('/')
}
</script>

<template>
  <div class="player-page" :class="{ 'theater-mode': theater }">
    <header class="watch-header">
      <router-link to="/" class="watch-brand" aria-label="返回首页">
        <span class="watch-logo"><svg viewBox="0 0 24 24" width="20" height="20" fill="none"><rect x="3" y="4" width="18" height="16" rx="5" stroke="currentColor" stroke-width="1.7"/><path d="m10 8 6 4-6 4Z" fill="currentColor"/></svg></span>
        AniShare
      </router-link>
      <button class="return-link" @click="back"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 6-6 6 6 6"/></svg>返回番剧</button>
    </header>

    <main class="watch-main">
      <div class="watch-breadcrumb">
        <router-link :to="{ name: 'library', query: { library: activeLibrary } }">{{ info?.libraryName || '媒体库' }}</router-link><span>/</span>
        <router-link v-if="info" :to="{ name: 'browse', query: { path: info.dir, library: activeLibrary } }">{{ info.dirName }}</router-link>
        <span v-else>正在载入</span>
        <span>/</span><span class="breadcrumb-current">{{ ep.episode ? `第 ${ep.episode} 集` : '正在播放' }}</span>
      </div>

      <div class="watch-layout">
        <section class="screen-column" aria-label="视频播放器">
          <div v-if="error" class="playback-error" role="alert">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/></svg>
            <span>{{ error }}</span><button @click="load">重新加载</button>
          </div>
          <div class="player-shell">
            <div ref="playerEl" class="player-host" />
            <transition name="fade">
              <div v-if="loading || busy" class="loading-overlay" role="status" aria-live="polite">
                <span class="screen-spinner" />
                <strong>{{ busy || statusText || '加载中…' }}</strong>
              </div>
            </transition>
            <div v-if="error && !art && !loading" class="screen-empty" aria-hidden="true"><svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></svg><span>暂时无法播放</span></div>
          </div>
          <div class="screen-toolbar">
            <div class="playback-state"><span class="state-dot"/><span>{{ loading ? '准备中' : mode === 'direct' ? '原画播放' : '兼容播放' }}</span><span v-if="v?.height" class="quality-label">{{ v.height >= 2160 ? '4K' : `${v.height}P` }}</span></div>
            <button class="theater-button" :aria-pressed="theater" @click="theater = !theater" :title="theater ? '退出剧场模式' : '剧场模式'"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10v6H7z"/></svg>{{ theater ? '常规视图' : '剧场模式' }}</button>
          </div>

          <div class="watch-title-block">
            <h1>{{ title || (loading ? '加载中…' : '未选择视频') }}</h1>
            <div class="title-meta"><span v-if="info?.duration">{{ fmtTime(info.duration) }}</span><span v-if="v">{{ codecLabel(v.codec) }}</span><span v-if="info?.size">{{ fmtSize(info.size) }}</span><span v-if="subs.length + streams.length">{{ subs.length + streams.length }} 条字幕</span></div>
            <p v-if="notice" class="playback-notice" role="status">{{ notice }}</p>
          </div>

          <div class="episode-navigation">
            <button :disabled="!prevEp" @click="prevEp && router.replace(watchTarget(prevEp.path))"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg><span><strong>上一集</strong></span></button>
            <span class="episode-position">{{ currentIndex >= 0 ? String(currentIndex + 1).padStart(2, '0') : '—' }}<span>/ {{ episodes.length || '—' }}</span></span>
            <button class="next-episode" :disabled="!nextEp" @click="nextEp && router.replace(watchTarget(nextEp.path))"><span><strong>下一集</strong></span><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
          </div>

          <details v-if="info" class="media-details">
            <summary><span>视频与字幕信息</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 9 6 6 6-6"/></svg></summary>
            <div class="details-content">
              <p class="file-name">{{ info.name }}</p>
              <p class="playback-reason">{{ info.playback.reason }}</p>
              <div class="detail-chips"><span v-if="v">{{ v.width }} × {{ v.height }}</span><span v-if="v?.fps">{{ v.fps }} fps</span><span v-if="info.probe?.audio?.[0]">{{ codecLabel(info.probe.audio[0].codec) }} · {{ info.probe.audio[0].channels }}ch</span><span>{{ info.name.split('.').pop().toUpperCase() }}</span></div>
              <h2>字幕轨道 <small>在播放器设置中切换</small></h2>
              <div class="subtitle-tracks"><span v-for="s in subs" :key="s.path" :class="{ 'image-subtitle': s.image }">{{ langLabel(s.lang) || '外挂' }} · {{ s.ext.slice(1).toUpperCase() }}{{ s.image ? '（图形字幕）' : '' }}</span><span v-for="s in streams" :key="s.index">内挂 · {{ langLabel(s.language) || codecLabel(s.codec) }}{{ s.title ? ` ${s.title}` : '' }}</span><p v-if="!subs.length && !streams.length">暂无字幕。可将同名 .ass / .srt 字幕放在视频旁。</p></div>
            </div>
          </details>
          <p class="keyboard-hint"><kbd>Space</kbd> 播放 / 暂停 <span>·</span><kbd>←</kbd><kbd>→</kbd> 快退 / 快进 <span>·</span><kbd>F</kbd> 全屏</p>
        </section>

        <aside class="episodes-panel" aria-label="剧集列表">
          <div class="episodes-heading"><div><h2>剧集列表<span>{{ episodes.length }} 集</span></h2></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></div>
          <p v-if="info?.dirName" class="collection-name">{{ info.dirName }}</p>
          <label v-if="episodes.length > 8" class="episode-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input v-model="episodeKeyword" type="search" placeholder="搜索集数或名称" aria-label="搜索剧集"/></label>
          <div class="episode-list">
            <div v-if="loading && !episodes.length" class="episode-list-empty">正在载入剧集…</div>
            <div v-else-if="!visibleEpisodes.length" class="episode-list-empty">{{ episodeKeyword ? '没有找到匹配的剧集' : '暂无剧集' }}</div>
            <router-link v-for="e in visibleEpisodes" :key="e.path" :to="watchTarget(e.path)" class="episode-item" :class="{ current: e.current }" :aria-current="e.current ? 'true' : undefined" :title="e.name">
              <span class="episode-number">{{ String(e.number).padStart(2, '0') }}</span>
              <span class="episode-copy"><strong>{{ prettyTitle(e.name) }}</strong><small v-if="e.current">正在播放</small></span>
              <span v-if="e.current" class="equalizer" aria-hidden="true"><i/><i/><i/></span>
              <svg v-else class="episode-play" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="m9 6 9 6-9 6z"/></svg>
              <span v-if="e.current && info?.duration" class="episode-progress" :style="{ width: `${Math.min(100, currentTime / info.duration * 100)}%` }"/>
            </router-link>
          </div>
        </aside>
      </div>
    </main>
  </div>
</template>

<style scoped>
.player-page { --watch-accent: var(--accent, #a78bfa); min-height: 100vh; background: #09090b; color: #ededf1; padding-bottom: 28px; }
.watch-header { min-height: 60px; padding: 0 max(24px, calc((100vw - 1536px) / 2)); display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid #ffffff0c; }
.watch-brand { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 650; }
.watch-logo { width: 29px; height: 29px; display: grid; place-items: center; border: 1px solid #a78bfa30; border-radius: 7px; color: var(--watch-accent); }
.return-link { display: flex; align-items: center; gap: 5px; color: #a1a1aa; background: none; border: 0; padding: 7px 0 7px 8px; font-size: 12px; }
.return-link:hover { color: #ededf1; }
.watch-main { max-width: 1536px; margin: 0 auto; padding: 18px 24px 0; }
.watch-breadcrumb { display: flex; align-items: center; gap: 10px; color: #52525b; font-size: 12px; margin-bottom: 16px; min-width: 0; }
.watch-breadcrumb a { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #92929c; }
.watch-breadcrumb a:hover { color: #ededf1; }
.breadcrumb-current { color: #c1c1ca; flex-shrink: 0; }
.watch-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 20px; align-items: start; }
.screen-column { min-width: 0; }
.player-shell { width: 100%; aspect-ratio: 16 / 9; position: relative; overflow: hidden; border: 1px solid #ffffff12; border-radius: 8px 8px 0 0; background: #000; }
.player-host { width: 100%; height: 100%; }
.loading-overlay, .screen-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #a1a1aa; background: #070709ed; font-size: 12px; z-index: 10; pointer-events: none; }
.loading-overlay strong { font-size: 13px; font-weight: 450; }
.screen-empty { z-index: 1; color: #71717a; }
.screen-spinner { width: 26px; height: 26px; border: 2px solid #a78bfa20; border-top-color: var(--watch-accent); border-radius: 50%; animation: screen-spin 1s linear infinite; }
@keyframes screen-spin { to { transform: rotate(360deg); } }
.screen-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 39px; padding: 0 13px; background: #111114; border: 1px solid #ffffff0c; border-top: 0; border-radius: 0 0 8px 8px; }
.playback-state { display: flex; align-items: center; gap: 7px; color: #9999a3; font-size: 11px; }
.state-dot { width: 4px; height: 4px; background: var(--watch-accent); display: inline-block; border-radius: 50%; }
.quality-label { margin-left: 4px; font-size: 9px; color: #b9b9c2; border: 1px solid #ffffff15; border-radius: 3px; padding: 1px 5px; }
.theater-button { display: flex; align-items: center; gap: 6px; border: 0; background: none; color: #9999a3; font-size: 11px; padding: 5px 0 5px 10px; }
.theater-button:hover { color: #ededf1; }
.watch-title-block { padding: 18px 0; }
h1 { font-size: clamp(18px, 1.7vw, 23px); font-weight: 550; line-height: 1.5; margin: 0 0 8px; overflow-wrap: anywhere; }
.title-meta { display: flex; align-items: center; flex-wrap: wrap; color: #85858f; font-size: 11px; }
.title-meta span + span:before { content: '·'; margin: 0 9px; color: #52525b; }
.playback-notice { color: #b9a7e9; padding: 8px 0 0; margin: 0; font-size: 12px; }
.playback-error { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; padding: 12px; border: 1px solid #fb718530; border-radius: 8px; background: #fb718508; color: #f5acb7; font-size: 12px; }
.playback-error svg { flex-shrink: 0; }
.playback-error span { flex: 1; overflow-wrap: anywhere; }
.playback-error button { flex-shrink: 0; background: none; color: #f5c5cd; border: 1px solid #fb718540; padding: 5px 8px; border-radius: 5px; font-size: 11px; }
.episode-navigation { border-top: 1px solid #ffffff10; border-bottom: 1px solid #ffffff10; padding: 10px 0; display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.episode-navigation button { display: flex; align-items: center; gap: 9px; border: 0; padding: 5px 0; background: none; color: #c5c5ce; }
.episode-navigation button:hover:not(:disabled) { color: var(--watch-accent); }
.episode-navigation button:disabled { opacity: .25; cursor: default; }
.episode-navigation strong { font-size: 12px; font-weight: 450; }
.episode-position { font-family: ui-monospace, monospace; font-size: 13px; color: #bebec8; }
.episode-position > span { margin-left: 6px; font-size: 11px; color: #64646e; }
.media-details { margin-top: 14px; border: 1px solid #ffffff0e; border-radius: 7px; background: #ffffff02; }
.media-details summary { list-style: none; display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 12px 14px; font-size: 12px; color: #9999a3; }
.media-details summary::-webkit-details-marker { display: none; }
.media-details[open] summary svg { transform: rotate(180deg); }
.details-content { border-top: 1px solid #ffffff0b; padding: 13px 14px 15px; }
.file-name { margin: 0; font-family: ui-monospace, monospace; color: #a1a1aa; font-size: 11px; line-height: 1.8; word-break: break-all; }
.playback-reason { color: #85858f; font-size: 11px; line-height: 1.7; margin: 8px 0 10px; }
.detail-chips, .subtitle-tracks { display: flex; flex-wrap: wrap; gap: 6px; }
.detail-chips span, .subtitle-tracks > span { color: #a1a1aa; font-size: 10px; padding: 4px 7px; background: #ffffff03; border: 1px solid #ffffff0a; border-radius: 4px; overflow-wrap: anywhere; }
.details-content h2 { margin: 16px 0 9px; font-size: 12px; color: #b1b1bb; font-weight: 450; }
.details-content h2 small { color: #71717a; margin-left: 8px; font-size: 10px; font-weight: 400; }
.subtitle-tracks .image-subtitle { color: #c7ac8d; }
.subtitle-tracks p { font-size: 11px; color: #85858f; margin: 0; }
.keyboard-hint { display: flex; align-items: center; justify-content: center; gap: 6px; color: #64646e; font-size: 10px; margin: 15px 0 0; }
.keyboard-hint > span { padding: 0 5px; }
kbd { font-family: inherit; font-size: 9px; color: #85858f; border: 1px solid #ffffff12; padding: 1px 4px; border-radius: 3px; }
.episodes-panel { min-width: 0; padding: 17px 0 0; border: 1px solid #ffffff0e; border-radius: 8px; background: #101013; overflow: hidden; }
.episodes-heading { padding: 0 16px; display: flex; align-items: center; justify-content: space-between; color: #64646e; }
.episodes-heading h2 { font-size: 14px; font-weight: 550; color: #d5d5dd; margin: 0; }
.episodes-heading h2 span { margin-left: 9px; font-size: 10px; color: #85858f; font-weight: 400; }
.collection-name { font-size: 11px; color: #85858f; line-height: 1.6; margin: 10px 16px 13px; overflow-wrap: anywhere; }
.episode-search { display: flex; align-items: center; gap: 7px; color: #71717a; background: #09090b; border: 1px solid #ffffff0a; border-radius: 5px; height: 32px; padding: 0 9px; margin: 0 12px 9px; }
.episode-search:focus-within { border-color: #a78bfa50; }
.episode-search input { border: 0; background: none; width: 100%; outline: 0; color: #c1c1ca; font-size: 11px; min-width: 0; }
.episode-search input::placeholder { color: #64646e; }
.episode-list { max-height: 555px; overflow: auto; padding: 0 8px 8px; scrollbar-width: thin; scrollbar-color: #33333b transparent; }
.episode-list-empty { text-align: center; padding: 28px 10px; color: #85858f; font-size: 12px; }
.episode-item { display: flex; align-items: center; gap: 10px; position: relative; padding: 11px 10px; border: 1px solid transparent; border-radius: 5px; overflow: hidden; margin: 2px 0; }
.episode-item:hover { background: #ffffff04; }
.episode-item.current { background: #a78bfa0a; border-color: #a78bfa21; }
.episode-number { width: 24px; flex-shrink: 0; font-family: ui-monospace, monospace; font-size: 12px; color: #71717a; }
.current .episode-number { color: var(--watch-accent); }
.episode-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.episode-copy strong { display: block; font-weight: 450; font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.current .episode-copy strong { color: #d5d1e0; }
.episode-copy small { color: #a99aca; font-size: 9px; }
.episode-play { color: #85858f; opacity: 0; flex-shrink: 0; }
.episode-item:hover .episode-play { opacity: 1; }
.episode-progress { position: absolute; bottom: 0; left: 0; height: 2px; background: #a78bfa70; }
.equalizer { height: 14px; display: flex; align-items: center; gap: 2px; padding-right: 2px; }
.equalizer i { display: block; width: 2px; border-radius: 1px; background: var(--watch-accent); height: 6px; }
.equalizer i:nth-child(2) { height: 13px; }
.equalizer i:nth-child(3) { height: 9px; }
.theater-mode .watch-layout { grid-template-columns: minmax(0, 1fr); }
.theater-mode .episodes-panel { display: none; }
.theater-mode .player-shell { max-height: 77vh; aspect-ratio: 16 / 8; }
.theater-mode .watch-title-block, .theater-mode .episode-navigation, .theater-mode .media-details { max-width: 1100px; margin-left: auto; margin-right: auto; }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--watch-accent); outline-offset: 3px; }
@media (max-width: 1080px) { .watch-layout { grid-template-columns: minmax(0, 1fr) 245px; gap: 16px; } .watch-main { padding: 17px 20px 0; } .watch-header { padding: 0 20px; } }
@media (max-width: 850px) { .watch-layout { grid-template-columns: minmax(0, 1fr); } .episodes-panel { margin-top: 4px; } .episode-list { max-height: 300px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 6px; } .episode-copy strong { font-size: 12px; } .theater-button { display: none; } }
@media (max-width: 540px) { .watch-header { min-height: 54px; padding: 0 14px; } .watch-brand { font-size: 15px; gap: 8px; } .return-link { font-size: 11px; } .watch-main { padding: 14px 12px 0; } .watch-breadcrumb { font-size: 10px; margin-bottom: 13px; gap: 7px; } .player-shell { border-radius: 6px 6px 0 0; } .screen-toolbar { min-height: 35px; padding: 0 11px; } .watch-title-block { padding: 16px 0; } h1 { font-size: 18px; } .episode-navigation { padding: 8px 0; gap: 10px; } .episode-list { display: block; } .keyboard-hint { display: none; } .details-content h2 small { display: block; margin: 7px 0 0; } .playback-error { flex-wrap: wrap; } .loading-overlay { gap: 10px; } .loading-overlay strong { font-size: 12px; } .screen-spinner { width: 22px; height: 22px; } }
@media (prefers-reduced-motion: reduce) { .screen-spinner { animation-duration: 2s; } }
</style>

<style>
.player-page .art-video-player.artplayer-app { background: #000; font-family: inherit; }
.player-page .art-video-player .art-bottom { padding: 0 16px 6px; background: linear-gradient(transparent, #000e); }
.player-page .art-video-player .art-bottom .art-progress .art-progress-played { background: var(--accent, #a78bfa); }
.player-page .art-video-player .art-progress .art-progress-indicator { background: #d3c5f4; box-shadow: 0 0 0 4px #a78bfa15; }
.player-page .art-video-player .art-setting-panel { background: #141417f5; backdrop-filter: blur(16px); border-radius: 8px; border: 1px solid #ffffff14; color: #dedee5; }
.player-page .art-video-player .art-setting-panel .art-setting-item:hover { background: #a78bfa0b; }
.player-page .art-video-player .art-subtitle-box { bottom: 64px; text-shadow: 0 2px 4px #000, 0 0 3px #000; }
.player-page .art-video-player .art-notice { background: #141417ee; border: 1px solid #ffffff14; border-radius: 5px; font-size: 12px; color: #c9c9d2; }
.player-page .art-video-player .art-mask-show .art-state { border-radius: 50%; }
.player-page .art-video-player .art-info { border-radius: 7px; background: #101013f0; }
@media (max-width: 540px) { .player-page .art-video-player .art-bottom { padding: 0 8px 2px; } .player-page .art-video-player .art-subtitle-box { font-size: 18px !important; bottom: 48px; } }
</style>
