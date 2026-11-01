<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import Hls from 'hlsjs'
import Artplayer from 'artplayer'
import { api, codecLabel, fmtSize, fmtTime, langLabel, parseEpisode, prettyTitle } from '../api'

const props = defineProps({
  path: { type: String, required: true },
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

const art = shallowRef(null)
const hls = shallowRef(null)
const hlsSession = ref(null)
const playerEl = ref(null)

const subs = computed(() => info.value?.subs || [])
const streams = computed(() => (info.value?.streams || []).filter((s) => s.text))
const episodes = computed(() => info.value?.episodes || [])
const currentIndex = computed(() => episodes.value.findIndex((e) => e.current))
const prevEp = computed(() => (currentIndex.value > 0 ? episodes.value[currentIndex.value - 1] : null))
const nextEp = computed(() =>
  currentIndex.value >= 0 && currentIndex.value < episodes.value.length - 1 ? episodes.value[currentIndex.value + 1] : null,
)

const title = computed(() => (info.value ? prettyTitle(info.value.name) : ''))
const ep = computed(() => parseEpisode(info.value?.name || ''))
const v = computed(() => info.value?.probe?.video)
const playKey = computed(() => info.value?.playKey || props.path)

/* ---------------- 播放进度 ---------------- */
const PROGRESS_KEY = 'anishare.progress'
function loadProgress(key) {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}')[key] || null
  } catch {
    return null
  }
}
function saveProgress(key, time, duration, extra = {}) {
  if (!key || !duration) return
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}')
    all[key] = { path: key, time, duration, at: Date.now(), ...extra }
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 80)
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {}
}
let lastSaved = 0

/* ---------------- 播放器核心 ---------------- */

// 调试开关：浏览器控制台执行 localStorage.setItem('anishare.debug','1') 后刷新
const dbg = (...a) => {
  if (localStorage?.getItem?.('anishare.debug') === '1') console.log('[pg]', ...a)
}

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
    theme: '#7c5cff',
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
  clearTimeout(markUserSeek.t)
  // 用 setSeek 让 hls.js 自己的 startPosition 跟着走，避免它把播放头拉回旧位置
  try {
    a.setSeek(t)
  } catch {}
  a.video.currentTime = t
}

/* ---------- 转码流：seek / 追流 ---------- */

function onSeeking() {
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
    hlsInfo = await api.hlsInfo(s.id)
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
    setTimeout(fixDuration, 1500)
  })
  h.on(Hls.Events.LEVEL_LOADED, () => refreshInfo())
  h.on(Hls.Events.ERROR, (_e, data) => {
    dbg('hls error', data.type, data.details, 'fatal', data.fatal, 'code', data.response?.code || '')
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      h.recoverMediaError()
    } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      setTimeout(() => h.startLoad(), 1500)
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
  if (!a || recovering) return
  const target = Math.max(0, Math.floor(Number(from) || 0))
  recovering = true
  busy.value = '正在从该位置开始转码…'
  clearTimeout(recoverTimer)
  clearInterval(watchdogTimer)
  dbg('restartTranscode →', target)
  try {
    const s = await api.hlsStart(props.path, target)
    if (art.value !== a) return
    releaseSession()
    hlsSession.value = s
    hlsInfo = { start: s.start, frontier: s.start, ended: false }
    resumeAt = target
    a.video.pause()
    startHls(s.m3u8, a, target)
    startWatchdog(target)
  } catch (e) {
    error.value = e.message
    busy.value = ''
  } finally {
    recovering = false
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
    const frontier = hlsInfo?.frontier || 0
    const ready = bufferedNear(v, t, 0.3)
    // 1) 目标还没转出来
    if (target > frontier + 1) {
      busy.value = `正在从 ${fmtTime(target)} 开始转码…`
      if (!v.paused && t > frontier - 3) v.pause()
      if (Math.abs(t - target) > 2) silentSeek(Math.min(target, frontier > 0 ? Math.max(frontier - 1, 0) : 0))
      return
    }
    // 2) 播放头在缓冲之外（转码还没追上）
    if (!ready) {
      busy.value = '正在等待转码追赶…'
      stuck++
      if (t < (hlsInfo?.start || 0) - 2) {
        silentSeek(hlsInfo.start)
        v.play().catch(() => {})
        stuck = 0
        return
      }
      if (v.paused && t <= frontier - 3) v.play().catch(() => {})
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
    if (v.paused) v.play().catch(() => {})
  }, 1000)
}

/** 记录实际播放位置（用于续播） */
function rememberProgress() {
  const a = art.value
  if (!a || !info.value) return
  saveProgress(playKey.value, a.video.currentTime, info.value.duration || 0, { title: title.value, hevc: Boolean(v.value?.hevc) })
}

function addSettings(artplayer) {
  // 字幕菜单（外挂 + 内挂）
  const list = []
  for (const s of subs.value) {
    if (s.image) continue
    list.push({
      html: `外挂 · ${langLabel(s.lang) || s.ext.slice(1).toUpperCase()}${s.name.includes('chs') ? ' 简体' : ''}`,
      url: api.subtitleUrl(s.path),
      type: 'vtt',
    })
  }
  for (const s of streams.value) {
    list.push({
      html: `内挂 · ${langLabel(s.language) || codecLabel(s.codec)}${s.title ? ' ' + s.title : ''}`,
      url: api.streamSubtitleUrl(props.path, s.index),
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
  artplayer.video.addEventListener('seeking', onSeeking)
  artplayer.on('video:loadedmetadata', () => {
    // 直链续播（转码流由 hls.js 的 startPosition 负责）
    if (mode.value === 'direct' && resumeAt > 1 && artplayer.video.currentTime < 0.5) {
      artplayer.video.currentTime = resumeAt
      artplayer.notice.show = `已从 ${fmtTime(resumeAt)} 继续播放`
    }
  })
  artplayer.on('video:playing', () => {
    busy.value = ''
  })
  artplayer.on('video:timeupdate', () => {
    const a = art.value
    if (!a) return
    if (a.video.currentTime - lastSaved > 5) {
      lastSaved = a.video.currentTime
      const dur = Number.isFinite(a.video.duration) && a.video.duration > 0 ? a.video.duration : info.value?.duration || 0
      saveProgress(playKey.value, a.video.currentTime, dur, { title: title.value, hevc: Boolean(v.value?.hevc) })
    }
  })
  artplayer.on('video:ended', () => {
    if (nextEp.value) router.replace({ name: 'watch', query: { path: nextEp.value.path } })
  })
}

async function setupDirect(startAt) {
  mode.value = 'direct'
  const a = new Artplayer(baseOptions({ url: api.streamUrl(props.path), type: detectType(info.value?.name) }))
  art.value = a
  addSettings(a)
  bindEvents(a)
  let fallenBack = false
  a.on('error', () => {
    if (fallenBack) return
    fallenBack = true
    const at = a.video.currentTime || startAt || 0
    a.destroy(false)
    art.value = null
    error.value = '浏览器无法直接播放该文件，已切换为服务端实时转码'
    resumeAt = at
    setupTranscode(at)
  })
  a.once('video:loadedmetadata', () => {
    if (startAt > 2) a.video.currentTime = startAt
  })
}

async function setupTranscode(startAt) {
  mode.value = 'transcode'
  resumeAt = startAt || 0
  loading.value = true
  statusText.value = '正在启动转码…'
  const session = await api.hlsStart(props.path, resumeAt)
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
  destroy()
  loading.value = true
  error.value = ''
  hlsReady.value = false
  lastSaved = 0
  statusText.value = '正在分析媒体…'
  try {
    const data = await api.video(props.path)
    info.value = data
    const saved = loadProgress(data.playKey || props.path)
    const fromQuery = props.t || 0
    const startAt = fromQuery > 0 ? fromQuery : saved && saved.time > 10 && saved.time < (data.duration || Infinity) - 30 ? saved.time : 0
    await nextTick()
    if (data.playback.directPlay) {
      await setupDirect(startAt)
      loading.value = false
    } else {
      await setupTranscode(Math.floor(startAt))
    }
  } catch (e) {
    error.value = e.message
    loading.value = false
  }
}

onMounted(load)
watch(() => props.path, load)
onBeforeUnmount(() => {
  if (art.value && info.value) {
    saveProgress(playKey.value, art.value.video.currentTime, art.value.video.duration || info.value.duration, { title: title.value })
  }
  destroy()
})

function back() {
  if (window.history.length > 1) router.back()
  else if (info.value?.dir) router.push({ name: 'browse', query: { path: info.value.dir } })
  else router.push('/')
}
</script>

<template>
  <div class="player-page">
    <header class="p-head">
      <button class="btn ghost small" @click="back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
        返回
      </button>
      <div class="p-title">
        <span v-if="ep.episode" class="ep-badge">{{ ep.season ? `S${ep.season}` : '' }} EP{{ String(ep.episode).padStart(2, '0') }}</span>
        <h1>{{ title }}</h1>
      </div>
      <div class="spacer" />
      <div class="p-actions">
        <button class="btn small" :disabled="!prevEp" title="上一集" @click="prevEp && router.replace({ name: 'watch', query: { path: prevEp.path } })">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
          上一集
        </button>
        <button class="btn small" :disabled="!nextEp" title="下一集" @click="nextEp && router.replace({ name: 'watch', query: { path: nextEp.path } })">
          下一集
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
        </button>
      </div>
    </header>

    <div v-if="error" class="p-error">{{ error }}</div>

    <div class="player-shell">
      <div ref="playerEl" class="player-host" />
      <transition name="fade">
        <div v-if="loading || busy" class="loading-overlay">
          <div class="spinner" />
          <span>{{ busy || statusText || '加载中…' }}</span>
        </div>
      </transition>
    </div>

    <section class="p-info container">
      <div class="badges" v-if="info">
        <span class="chip" :class="info.playback.directPlay ? 'ok' : 'hevc'">
          {{ info.playback.directPlay ? '直链播放' : '实时转码' }}
        </span>
        <span v-if="v" class="chip" :class="v.hevc ? 'hevc' : 'h264'">{{ codecLabel(v.codec) }}</span>
        <span v-if="v" class="chip mono">{{ v.width }}×{{ v.height }}</span>
        <span v-if="v?.fps" class="chip mono">{{ v.fps }}fps</span>
        <span v-if="v?.pixFmt" class="chip mono">{{ v.pixFmt }}</span>
        <span v-if="info.probe?.audio?.[0]" class="chip">{{ codecLabel(info.probe.audio[0].codec) }} {{ info.probe.audio[0].channels }}ch</span>
        <span v-if="info.size" class="chip">{{ fmtSize(info.size) }}</span>
        <span v-if="info.duration" class="chip mono">{{ fmtTime(info.duration, { withHours: true }) }}</span>
        <span class="chip">{{ info.name.split('.').pop().toUpperCase() }}</span>
      </div>
      <p class="reason muted" v-if="info">{{ info.playback.reason }}</p>

      <div class="cols">
        <div class="col-main">
          <h3>文件</h3>
          <div class="file-name mono">{{ info?.name }}</div>
          <h3 v-if="subs.length || streams.length">字幕轨道</h3>
          <div class="sub-list" v-if="info">
            <span v-for="s in subs" :key="s.path" class="chip" :class="{ err: s.image }">
              {{ langLabel(s.lang) || '外挂' }} · {{ s.ext.slice(1).toUpperCase() }}<template v-if="s.image">（图形字幕）</template>
            </span>
            <span v-for="s in streams" :key="s.index" class="chip hevc">
              内挂 · {{ langLabel(s.language) || codecLabel(s.codec) }}{{ s.title ? ' ' + s.title : '' }}
            </span>
            <span v-if="!subs.length && !streams.length" class="faint small">无字幕轨道（可把 .ass/.srt 同名放在视频旁边）</span>
          </div>
        </div>
        <div class="col-side">
          <div class="tabs">
            <span class="tab-title">选集</span>
            <span class="faint">{{ episodes.length }} 集</span>
          </div>
          <div class="ep-list">
            <router-link
              v-for="(e, i) in episodes"
              :key="e.path"
              :to="{ name: 'watch', query: { path: e.path } }"
              class="ep-item"
              :class="{ on: e.current }"
            >
              <span class="ep-no">{{ String(parseEpisode(e.name).episode || i + 1).padStart(2, '0') }}</span>
              <span class="ep-name">{{ prettyTitle(e.name) }}</span>
            </router-link>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.player-page {
  min-height: 100vh;
  padding-bottom: 60px;
  background: linear-gradient(180deg, #05060a 0%, var(--bg) 320px);
}
.p-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line);
}
.p-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.p-title h1 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ep-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(124, 92, 255, 0.2);
  border: 1px solid rgba(124, 92, 255, 0.45);
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.p-actions {
  display: flex;
  gap: 8px;
}
.player-shell {
  position: relative;
  width: 100%;
  background: #000;
  aspect-ratio: 16 / 9;
  max-height: calc(100vh - 64px - 80px);
  margin: 0 auto;
}
.player-host {
  width: 100%;
  height: 100%;
}
.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(5, 6, 10, 0.82);
  color: var(--text-dim);
  font-size: 14px;
  z-index: 10;
  pointer-events: none;
}
.p-error {
  margin: 16px auto;
  max-width: 900px;
  padding: 12px 16px;
  border-radius: 12px;
  background: rgba(255, 92, 108, 0.1);
  border: 1px solid rgba(255, 92, 108, 0.3);
  color: #ffc2c8;
  font-size: 13px;
}
.p-info {
  padding-top: 22px;
}
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.reason {
  margin: 12px 0 24px;
  font-size: 13px;
}
.cols {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 32px;
}
h3 {
  font-size: 13px;
  color: var(--text-faint);
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 24px 0 12px;
}
.col-main h3:first-child {
  margin-top: 0;
}
.file-name {
  font-size: 13px;
  line-height: 1.7;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  word-break: break-all;
}
.tabs {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
  font-size: 14px;
}
.tab-title {
  font-weight: 600;
}
.ep-list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}
.ep-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  color: var(--text-dim);
}
.ep-item:last-child {
  border-bottom: none;
}
.ep-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}
.ep-item.on {
  background: rgba(124, 92, 255, 0.14);
  color: var(--text);
  box-shadow: inset 3px 0 0 var(--accent);
}
.ep-no {
  font-family: ui-monospace, monospace;
  font-weight: 700;
  color: var(--accent);
}
.ep-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.small {
  font-size: 13px;
}
@media (max-width: 900px) {
  .cols {
    grid-template-columns: 1fr;
  }
  .p-head {
    padding: 12px;
  }
  .player-shell {
    max-height: none;
  }
}
</style>

<style>
/* Artplayer 深色皮肤微调（全局，作用于播放器内部） */
.art-video-player.artplayer-app {
  background: #000;
}
.art-video-player .art-bottom .art-progress .art-progress-played {
  background: var(--grad);
}
.art-video-player .art-setting-panel {
  background: rgba(20, 23, 32, 0.96);
  backdrop-filter: blur(16px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.art-video-player .art-subtitle-box {
  bottom: 64px;
}
</style>
