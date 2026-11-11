<script setup>
/**
 * 播放器「播放设置」浮层（手柄控制台式菜单）。
 *
 * - 根节点带 data-gp-overlay：dispatch.js 只在浮层范围内做空间导航，
 *   B 键由全局 dispatch 关闭（本组件不监听关闭，除「关闭」按钮外不自行关闭浮层）。
 * - 剧集 / 字幕 / 播放 / 页面四个页签；LB/RB 通过 useGamepadContext 切换。
 * - 浮层打开时 GamepadProvider 会把焦点送到 [data-gp-autofocus]（当前集按钮）。
 * - 所有可交互元素都是原生 button / router-link，保证真实 DOM 焦点可用。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useGamepadContext } from './useGamepad.js'

const props = defineProps({
  title: { type: String, default: '' },
  episodes: { type: Array, default: () => [] }, // [{ path, name, number, current }]
  episodeTotal: { type: Number, default: 0 },
  currentIndex: { type: Number, default: -1 },
  subtitles: { type: Array, default: () => [] }, // [{ id, label, active }]
  rate: { type: Number, default: 1 },
  volume: { type: Number, default: 0.9 },
  playing: { type: Boolean, default: false },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  links: { type: Array, default: () => [] }, // [{ label, to }]
})

const emit = defineEmits([
  'close',
  'play-pause',
  'prev',
  'next',
  'select-episode',
  'select-subtitle',
  'set-rate',
  'set-volume',
  'toggle-fullscreen',
])

const TABS = [
  { id: 'episodes', label: '剧集' },
  { id: 'subtitles', label: '字幕' },
  { id: 'playback', label: '播放' },
  { id: 'pages', label: '页面' },
]

const RATE_MIN = 0.5
const RATE_MAX = 2
const RATE_STEP = 0.25
const VOLUME_STEP = 0.05

const activeTab = ref('episodes')
const rootEl = ref(null)
const bodyEl = ref(null)

/* ---------------- 头部：当前集序号 ---------------- */

const positionText = computed(() => {
  const index = Number(props.currentIndex)
  return Number.isInteger(index) && index >= 0 ? String(index + 1).padStart(2, '0') : '—'
})

const totalText = computed(() => {
  const total = Number(props.episodeTotal) || props.episodes.length || 0
  return total > 0 ? String(total).padStart(2, '0') : '—'
})

/* ---------------- 页签 ---------------- */

function selectTab(id) {
  if (id === activeTab.value || !TABS.some((tab) => tab.id === id)) return
  activeTab.value = id
}

function shiftTab(step) {
  const index = TABS.findIndex((tab) => tab.id === activeTab.value)
  const next = TABS[(index + step + TABS.length) % TABS.length]
  if (next) activeTab.value = next.id
}

/** 切换页签后把焦点交给该页签，保证摇杆可以继续往下走 */
watch(activeTab, async () => {
  if (bodyEl.value) bodyEl.value.scrollTop = 0
  await nextTick()
  const tab = rootEl.value?.querySelector('.pad-tab.active')
  if (!tab || typeof tab.focus !== 'function') return
  try { tab.focus({ preventScroll: true }) } catch { try { tab.focus() } catch { /* ignore */ } }
})

// LB / RB：上一页签 / 下一页签（返回 true 消费动作，避免默认导航）
useGamepadContext({
  id: 'player-pad',
  overlay: true,
  hints: { 'prev-tab': '上一页签', 'next-tab': '下一页签' },
  handle(action) {
    if (action === 'prev-tab') { shiftTab(-1); return true }
    if (action === 'next-tab') { shiftTab(1); return true }
    return false
  },
})

/* ---------------- 剧集 ---------------- */

const autofocusIndex = computed(() => {
  const index = props.episodes.findIndex((episode) => episode?.current)
  if (index >= 0) return index
  return props.episodes.length ? 0 : -1
})

function episodeNumber(episode, index) {
  const value = episode?.number
  if (value === 0 || value) return String(value)
  return String(index + 1).padStart(2, '0')
}

function episodeTitle(episode) {
  return [episode?.number, episode?.name]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(' · ')
}

function chooseEpisode(episode) {
  if (!episode?.path) return
  emit('select-episode', episode.path)
}

/* ---------------- 倍速 / 音量 ---------------- */

const rateValue = computed(() => {
  const value = Number(props.rate)
  if (!Number.isFinite(value)) return 1
  return Math.min(RATE_MAX, Math.max(RATE_MIN, value))
})
const rateText = computed(() => `${Number(rateValue.value.toFixed(2))}×`)
const rateBar = computed(() => `${Math.round(((rateValue.value - RATE_MIN) / (RATE_MAX - RATE_MIN)) * 100)}%`)
const canRateDown = computed(() => rateValue.value > RATE_MIN + 0.001)
const canRateUp = computed(() => rateValue.value < RATE_MAX - 0.001)

function nudgeRate(step) {
  const current = rateValue.value
  // 吸附到 0.25 网格，避免播放器自带的非标准倍速让步进越来越碎
  const target = Math.round((current + step) * 4) / 4
  const next = Math.min(RATE_MAX, Math.max(RATE_MIN, target))
  if (Math.abs(next - current) < 0.001) return
  emit('set-rate', Number(next.toFixed(2)))
}

const volumeValue = computed(() => {
  const value = Number(props.volume)
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
})
const volumePercent = computed(() => Math.round(volumeValue.value * 100))
const canVolumeDown = computed(() => volumeValue.value > 0.001)
const canVolumeUp = computed(() => volumeValue.value < 0.999)

function nudgeVolume(step) {
  const current = volumeValue.value
  const next = Math.min(1, Math.max(0, Math.round((current + step) * 100) / 100))
  if (Math.abs(next - current) < 0.001) return
  emit('set-volume', next)
}

/* ---------------- 页面 ---------------- */

function pickLink() {
  emit('close')
}
</script>

<template>
  <div ref="rootEl" class="pad-backdrop" data-gp-overlay role="dialog" aria-modal="true" aria-label="播放设置">
    <div class="pad-panel">
      <header class="pad-header">
        <div class="pad-heading">
          <span class="pad-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 8h11a4.5 4.5 0 0 1 4.4 5.4l-.7 3.6a2.7 2.7 0 0 1-4.9 1.1L14.9 16H9.1l-1.4 2.1a2.7 2.7 0 0 1-4.9-1.1l-.7-3.6A4.5 4.5 0 0 1 6.5 8Z" />
              <path d="M8 10.5v3M6.5 12h3M15.5 11h.01M17.5 13h.01" />
            </svg>
          </span>
          <div class="pad-title-group">
            <h2>播放设置</h2>
            <p v-if="title" class="pad-now-playing" :title="title">{{ title }}</p>
          </div>
        </div>
        <div class="pad-head-actions">
          <span class="pad-position" aria-label="当前集数"><strong>{{ positionText }}</strong><span class="pad-position-total">/ {{ totalText }}</span></span>
          <button type="button" class="pad-close" aria-label="关闭播放设置" @click="emit('close')">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            关闭
          </button>
        </div>
      </header>

      <div class="pad-tabs" role="tablist" aria-label="播放设置页签">
        <button
          v-for="tab in TABS"
          :id="`pad-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          class="pad-tab"
          :class="{ active: activeTab === tab.id }"
          :aria-selected="activeTab === tab.id ? 'true' : 'false'"
          :aria-controls="`pad-panel-${tab.id}`"
          :data-gp-autofocus="tab.id === 'episodes' && !episodes.length ? '' : null"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}<span v-if="tab.id === 'episodes' && episodes.length" class="pad-tab-count">{{ episodes.length }}</span>
        </button>
      </div>

      <div ref="bodyEl" class="pad-body">
        <!-- 剧集 -->
        <section
          v-if="activeTab === 'episodes'"
          id="pad-panel-episodes"
          role="tabpanel"
          aria-labelledby="pad-tab-episodes"
          class="pad-section"
        >
          <div v-if="episodes.length" class="pad-episode-grid">
            <button
              v-for="(episode, index) in episodes"
              :key="episode.path || index"
              type="button"
              class="pad-episode"
              :class="{ current: episode.current }"
              data-gp-card
              :data-gp-autofocus="index === autofocusIndex ? '' : null"
              :aria-current="episode.current ? 'true' : undefined"
              :title="episodeTitle(episode)"
              @click="chooseEpisode(episode)"
            >
              <span class="episode-no">{{ episodeNumber(episode, index) }}</span>
              <span class="episode-name">{{ episode.name }}</span>
            </button>
          </div>
          <p v-else class="pad-empty">暂无可切换的剧集</p>
        </section>

        <!-- 字幕 -->
        <section
          v-else-if="activeTab === 'subtitles'"
          id="pad-panel-subtitles"
          role="tabpanel"
          aria-labelledby="pad-tab-subtitles"
          class="pad-section"
        >
          <div v-if="subtitles.length" class="pad-sub-list">
            <button
              v-for="subtitle in subtitles"
              :key="subtitle.id"
              type="button"
              class="pad-sub"
              :class="{ active: subtitle.active }"
              :aria-pressed="subtitle.active ? 'true' : 'false'"
              @click="emit('select-subtitle', subtitle.id)"
            >
              <span class="pad-check" aria-hidden="true">
                <svg v-if="subtitle.active" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7" /></svg>
                <span v-else class="pad-dot" />
              </span>
              <span class="pad-sub-label">{{ subtitle.label }}</span>
            </button>
          </div>
          <p v-else class="pad-empty">没有可用的字幕轨道</p>
        </section>

        <!-- 播放 -->
        <section
          v-else-if="activeTab === 'playback'"
          id="pad-panel-playback"
          role="tabpanel"
          aria-labelledby="pad-tab-playback"
          class="pad-section"
        >
          <div class="pad-playback">
            <div class="pad-group">
              <span class="pad-group-title">播放控制</span>
              <div class="pad-controls">
                <button type="button" class="pad-action" @click="emit('play-pause')">
                  <span class="pad-play-icon" aria-hidden="true">{{ playing ? '⏸' : '▶' }}</span>{{ playing ? '暂停' : '播放' }}
                </button>
                <button type="button" class="pad-action" :disabled="!hasPrev" @click="emit('prev')">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>上一集
                </button>
                <button type="button" class="pad-action" :disabled="!hasNext" @click="emit('next')">
                  下一集<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
                </button>
              </div>
            </div>

            <div class="pad-duo">
              <div class="pad-group">
                <div class="pad-group-head">
                  <span class="pad-group-title">播放速度</span>
                  <span class="pad-value">{{ rateText }}</span>
                </div>
                <div class="pad-stepper">
                  <button type="button" class="pad-action" :disabled="!canRateDown" @click="nudgeRate(-RATE_STEP)">
                    <span class="pad-sign" aria-hidden="true">−</span>减速
                  </button>
                  <span class="pad-meter" aria-hidden="true"><i :style="{ width: rateBar }" /></span>
                  <button type="button" class="pad-action" :disabled="!canRateUp" @click="nudgeRate(RATE_STEP)">
                    加速<span class="pad-sign" aria-hidden="true">+</span>
                  </button>
                </div>
              </div>

              <div class="pad-group">
                <div class="pad-group-head">
                  <span class="pad-group-title">音量</span>
                  <span class="pad-value">{{ volumePercent }}%</span>
                </div>
                <div class="pad-stepper">
                  <button type="button" class="pad-action" :disabled="!canVolumeDown" @click="nudgeVolume(-VOLUME_STEP)">音量 <span class="pad-sign" aria-hidden="true">−</span></button>
                  <span class="pad-meter" aria-hidden="true"><i :style="{ width: `${volumePercent}%` }" /></span>
                  <button type="button" class="pad-action" :disabled="!canVolumeUp" @click="nudgeVolume(VOLUME_STEP)">音量 <span class="pad-sign" aria-hidden="true">+</span></button>
                </div>
              </div>
            </div>

            <div class="pad-group">
              <span class="pad-group-title">显示</span>
              <div class="pad-controls">
                <button type="button" class="pad-action" @click="emit('toggle-fullscreen')">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>全屏
                </button>
              </div>
            </div>

            <p class="pad-hint"><kbd>A</kbd> 选择 <span>·</span> <kbd>B</kbd> 关闭 <span>·</span> <kbd>LB</kbd>/<kbd>RB</kbd> 切换页签</p>
          </div>
        </section>

        <!-- 页面 -->
        <section
          v-else-if="activeTab === 'pages'"
          id="pad-panel-pages"
          role="tabpanel"
          aria-labelledby="pad-tab-pages"
          class="pad-section"
        >
          <div v-if="links.length" class="pad-links">
            <router-link v-for="(link, index) in links" :key="index" :to="link.to" class="pad-link" @click="pickLink">
              <span class="pad-link-label">{{ link.label }}</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </router-link>
          </div>
          <p v-else class="pad-empty">没有可跳转的页面</p>
          <button type="button" class="pad-action pad-wide" @click="emit('close')">关闭菜单</button>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------------- 遮罩与面板 ---------------- */
.pad-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60; /* 高于页面内容，低于底部 HUD（HUD 常显，不随模式/浮层变化） */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vw, 32px);
  background: radial-gradient(120% 90% at 50% 0%, #251d3fba 0%, #0a0910c4 52%, #050409e8 100%);
  backdrop-filter: blur(12px) saturate(115%);
  -webkit-backdrop-filter: blur(12px) saturate(115%);
}

.pad-panel {
  width: 100%;
  max-width: 900px;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #ffffff14;
  border-radius: 12px;
  background:
    linear-gradient(158deg, #241f35b8 0%, #14131b00 46%),
    #141119f5;
  box-shadow: 0 34px 90px #000000b3, 0 0 0 1px #a78bfa10 inset, 0 0 44px #a78bfa1a;
  color: #e8e6ef;
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  animation: pad-panel-in 0.18s ease-out;
}

@keyframes pad-panel-in {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

/* ---------------- 头部 ---------------- */
.pad-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid #ffffff0d;
}

.pad-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.pad-badge {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  color: #c4b5fd;
  background: #a78bfa14;
  border: 1px solid #a78bfa33;
  border-radius: 9px;
}

.pad-title-group {
  min-width: 0;
}

.pad-title-group h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #edeaf6;
}

.pad-now-playing {
  max-width: 460px;
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: #8d88a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pad-head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}

.pad-position {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: #6f6a80;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}

.pad-position strong {
  font-size: 13px;
  font-weight: 500;
  color: #cfc3f4;
}

.pad-position-total {
  margin-left: 4px;
}

.pad-close {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid #ffffff14;
  border-radius: 7px;
  background: #ffffff05;
  color: #a7a3b4;
  font-size: 11.5px;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.pad-close:hover {
  background: #ffffff0c;
  border-color: #ffffff26;
  color: #edeaf6;
}

.pad-close svg {
  width: 13px;
  height: 13px;
}

/* ---------------- 页签 ---------------- */
.pad-tabs {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 9px 14px 0;
  border-bottom: 1px solid #ffffff0d;
  overflow-x: auto;
  scrollbar-width: none;
}

.pad-tabs::-webkit-scrollbar {
  display: none;
}

.pad-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 15px 10px;
  border: 0;
  border-radius: 8px 8px 0 0;
  background: none;
  color: #847f95;
  font-size: 12.5px;
  white-space: nowrap;
  transition: color 0.12s, background 0.12s;
}

.pad-tab:hover {
  color: #ded9ec;
  background: #ffffff04;
}

.pad-tab.active {
  color: #d6c9fb;
  background: linear-gradient(180deg, #a78bfa12, #a78bfa05);
}

.pad-tab.active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(90deg, #a78bfa00, #a78bfa, #a78bfa00);
}

.pad-tab-count {
  min-width: 17px;
  height: 15px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: #ffffff08;
  border: 1px solid #ffffff0e;
  color: #8b86a0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 9px;
}

.pad-tab.active .pad-tab-count {
  background: #a78bfa1f;
  border-color: #a78bfa38;
  color: #cbbcf7;
}

/* ---------------- 内容区（滚动） ---------------- */
.pad-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 15px 18px 18px;
  scrollbar-width: thin;
  scrollbar-color: #4b3f63 transparent;
}

.pad-section {
  outline: none;
}

.pad-empty {
  margin: 28px 0;
  text-align: center;
  color: #77728a;
  font-size: 12px;
}

/* ---------------- 剧集网格 ---------------- */
.pad-episode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 7px;
}

.pad-episode {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-height: 52px;
  padding: 7px 9px;
  overflow: hidden;
  border: 1px solid #ffffff0c;
  border-radius: 8px;
  background: #ffffff04;
  color: #b6b1c4;
  text-align: left;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.pad-episode:hover {
  background: #ffffff09;
  border-color: #ffffff22;
  color: #e5e1ee;
}

.pad-episode .episode-no {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.15;
  color: #c8c3d6;
  font-variant-numeric: tabular-nums;
}

.pad-episode .episode-name {
  max-width: 100%;
  font-size: 9px;
  line-height: 1.35;
  color: #6f6a80;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pad-episode.current {
  background: #a78bfa1a;
  border-color: #a78bfa;
  color: #e4dcfb;
  box-shadow: inset 0 0 14px #a78bfa14;
}

.pad-episode.current .episode-no {
  color: #c4b5fd;
}

.pad-episode.current .episode-name {
  color: #a99aca;
}

/* ---------------- 字幕列表 ---------------- */
.pad-sub-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pad-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid #ffffff0b;
  border-radius: 8px;
  background: #ffffff03;
  color: #b9b4c6;
  font-size: 12px;
  text-align: left;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.pad-sub:hover {
  background: #ffffff08;
  border-color: #ffffff20;
  color: #e7e3f0;
}

.pad-sub.active {
  background: #a78bfa1a;
  border-color: #a78bfa;
  color: #dcd2fb;
}

.pad-check {
  width: 16px;
  height: 16px;
  flex: none;
  display: grid;
  place-items: center;
  color: #a78bfa;
}

.pad-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #55505f;
}

.pad-sub.active .pad-dot {
  background: #a78bfa;
}

.pad-sub-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ---------------- 播放控制 ---------------- */
.pad-playback {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pad-group {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.pad-group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.pad-group-title {
  font-size: 10px;
  letter-spacing: 0.09em;
  color: #716c83;
}

.pad-value {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  color: #cbbcf7;
}

.pad-duo {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.pad-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 7px;
}

.pad-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 39px;
  padding: 0 13px;
  border: 1px solid #ffffff12;
  border-radius: 8px;
  background: #ffffff05;
  color: #d6d2e2;
  font-size: 12px;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.pad-action:hover:not(:disabled) {
  background: #a78bfa0f;
  border-color: #a78bfa52;
  color: #ece6fb;
}

.pad-action:disabled {
  opacity: 0.32;
}

.pad-action svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.pad-play-icon {
  font-size: 11px;
  color: #c4b5fd;
}

.pad-sign {
  color: #a78bfa;
  font-family: ui-monospace, Consolas, monospace;
}

.pad-stepper {
  display: grid;
  grid-template-columns: auto minmax(40px, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.pad-meter {
  position: relative;
  display: block;
  height: 5px;
  border-radius: 99px;
  background: #ffffff09;
  overflow: hidden;
}

.pad-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #7c5fd3, #c4b5fd);
  transition: width 0.15s ease;
}

.pad-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 0;
  padding-top: 12px;
  border-top: 1px solid #ffffff08;
  color: #726c85;
  font-size: 10.5px;
}

.pad-hint > span {
  margin: 0 2px;
  color: #4a4555;
}

.pad-hint kbd {
  padding: 1px 5px;
  border: 1px solid #a78bfa28;
  border-radius: 4px;
  background: #a78bfa10;
  color: #a99aca;
  font-family: inherit;
  font-size: 9px;
}

/* ---------------- 页面链接 ---------------- */
.pad-links {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pad-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  padding: 10px 13px;
  border: 1px solid #ffffff0b;
  border-radius: 8px;
  background: #ffffff03;
  color: #c3becf;
  font-size: 12.5px;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.pad-link:hover {
  background: #a78bfa0d;
  border-color: #a78bfa45;
  color: #e9e3fa;
}

.pad-link-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pad-link svg {
  width: 14px;
  height: 14px;
  flex: none;
  color: #6f6a80;
}

.pad-link:hover svg {
  color: #c4b5fd;
}

.pad-wide {
  width: 100%;
  margin-top: 14px;
}

/* 键盘用户：全局已有 focus-visible，这里补一层与浮层一致的描边 */
.pad-panel button:focus-visible,
.pad-panel a:focus-visible {
  outline: 2px solid #c4b5fd;
  outline-offset: 2px;
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 640px) {
  .pad-backdrop {
    align-items: flex-end;
    padding: 0;
  }

  .pad-panel {
    width: 100%;
    max-height: 88vh;
    border-bottom: 0;
    border-radius: 14px 14px 0 0;
  }

  .pad-header {
    padding: 13px 14px 11px;
  }

  .pad-now-playing {
    max-width: 38vw;
  }

  .pad-tabs {
    padding: 7px 9px 0;
  }

  .pad-body {
    padding: 12px 12px 16px;
  }

  .pad-position {
    font-size: 10px;
  }

  .pad-duo,
  .pad-stepper {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .pad-meter {
    order: 2;
    margin: 2px 2px 5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pad-panel {
    animation: none;
  }

  .pad-meter i {
    transition: none;
  }
}
</style>
