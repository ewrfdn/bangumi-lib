<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import { api, fmtSize } from '../api'

const router = useRouter()
const loading = ref(true)
const data = ref(null)
const error = ref('')
const keyword = ref('')

const series = computed(() => data.value?.series || [])
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return series.value
  return series.value.filter((s) => s.name.toLowerCase().includes(k))
})
const totalVideos = computed(() => series.value.reduce((n, s) => n + (s.count || 0), 0))
const totalSize = ref(0)

onMounted(async () => {
  try {
    data.value = await api.library()
    error.value = data.value.error || ''
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function openSeries(s) {
  if (s.kind === 'video') return router.push({ name: 'watch', query: { path: s.path } })
  router.push({ name: 'browse', query: { path: s.path } })
}

function continueWatching() {
  try {
    return JSON.parse(localStorage.getItem('anishare.progress') || '{}')
  } catch {
    return {}
  }
}
const progress = continueWatching()
const recent = computed(() =>
  Object.values(progress)
    .filter((p) => p.path && p.duration && p.time > 5 && p.time < p.duration - 30)
    .sort((a, b) => b.at - a.at)
    .slice(0, 6),
)

function openRecent(p) {
  router.push({ name: 'watch', query: { path: p.path, t: Math.floor(p.time) } })
}
</script>

<template>
  <div class="home container">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">
          <span class="live-dot" />
          内网 · 无需登录
        </div>
        <h1>你的番剧库，<span class="grad">点开就播。</span></h1>
        <p class="sub">
          浏览 <code>{{ data?.root || '…' }}</code> 下的所有剧集，支持 H.264 / H.265 智能播放与外挂字幕。
        </p>
        <div class="stats">
          <div class="stat">
            <strong>{{ loading ? '—' : series.length }}</strong>
            <span>部番剧</span>
          </div>
          <div class="stat">
            <strong>{{ loading ? '—' : totalVideos }}</strong>
            <span>集视频</span>
          </div>
          <router-link to="/browse" class="btn primary browse-cta">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2z"/></svg>
            浏览文件夹
          </router-link>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="orb orb-a" />
        <div class="orb orb-b" />
        <div class="ring" />
        <div class="cards">
          <div class="mini-card c1" />
          <div class="mini-card c2" />
          <div class="mini-card c3" />
        </div>
      </div>
    </section>

    <section v-if="recent.length" class="recent">
      <div class="section-head">
        <h2>继续观看</h2>
      </div>
      <div class="recent-row">
        <button v-for="p in recent" :key="p.path" class="recent-card" @click="openRecent(p)">
          <div class="recent-thumb" :class="{ hevc: p.hevc }">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
          </div>
          <div class="recent-meta">
            <div class="recent-title" :title="p.title">{{ p.title }}</div>
            <div class="progress">
              <div class="bar" :style="{ width: `${Math.min(100, (p.time / p.duration) * 100)}%` }" />
            </div>
            <div class="recent-sub faint">{{ Math.round((p.time / p.duration) * 100) }}% 已观看</div>
          </div>
        </button>
      </div>
    </section>

    <section class="library">
      <div class="section-head">
        <h2>番剧库</h2>
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input v-model="keyword" placeholder="搜索番剧…" />
        </div>
      </div>

      <div v-if="error" class="notice err">{{ error }}</div>

      <div v-if="loading" class="grid">
        <div v-for="i in 8" :key="i" class="card sk">
          <div class="skeleton" style="aspect-ratio: 2/3; width: 100%" />
          <div class="skeleton" style="height: 14px; width: 70%; margin-top: 12px" />
        </div>
      </div>

      <div v-else-if="!filtered.length" class="empty">
        <div class="empty-icon">📺</div>
        <h3>{{ keyword ? '没有匹配的番剧' : '媒体目录还是空的' }}</h3>
        <p class="muted">
          {{ keyword ? '换个关键词试试' : `把视频放进 ${data?.root || 'BANGUMI_ROOT'} 下，刷新即可看到` }}
        </p>
      </div>

      <div v-else class="grid">
        <button
          v-for="s in filtered"
          :key="s.path"
          class="card"
          @click="openSeries(s)"
          :title="s.name"
        >
          <div class="poster-wrap">
            <Poster :name="s.name" :poster="s.poster" />
            <div class="hover-play">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
            </div>
            <span v-if="s.count" class="count-chip">{{ s.count }} 集</span>
          </div>
          <div class="card-title">{{ s.name }}</div>
          <div class="card-sub faint">
            <template v-if="s.items?.length > 1">{{ s.items.length }} 个文件夹</template>
            <template v-else>{{ s.count ? '点击进入' : '空文件夹' }}</template>
          </div>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  padding: 40px 0 80px;
}
.hero {
  position: relative;
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 32px;
  align-items: center;
  padding: 44px 0 56px;
  overflow: hidden;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 0 rgba(56, 214, 160, 0.6);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(56, 214, 160, 0.55); }
  70% { box-shadow: 0 0 0 8px rgba(56, 214, 160, 0); }
  100% { box-shadow: 0 0 0 0 rgba(56, 214, 160, 0); }
}
h1 {
  font-size: clamp(32px, 4.4vw, 56px);
  line-height: 1.1;
  margin: 18px 0 14px;
  letter-spacing: -0.5px;
}
.grad {
  background: var(--grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.sub {
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1.7;
  max-width: 560px;
}
.sub code {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--line);
  word-break: break-all;
}
.stats {
  display: flex;
  align-items: center;
  gap: 28px;
  margin-top: 30px;
}
.stat strong {
  display: block;
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat span {
  font-size: 13px;
  color: var(--text-faint);
}
.browse-cta {
  margin-left: 8px;
}
.hero-art {
  position: relative;
  height: 300px;
}
.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  opacity: 0.55;
}
.orb-a {
  width: 240px;
  height: 240px;
  right: 40px;
  top: 10px;
  background: #7c5cff;
}
.orb-b {
  width: 200px;
  height: 200px;
  right: 160px;
  bottom: 0;
  background: #ff5c8a;
  opacity: 0.4;
}
.ring {
  position: absolute;
  inset: 20px 20px auto auto;
  width: 260px;
  height: 260px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.cards {
  position: absolute;
  inset: 0;
}
.mini-card {
  position: absolute;
  width: 110px;
  border-radius: 12px;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.04));
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
}
.c1 { aspect-ratio: 2/3; right: 70px; top: 40px; transform: rotate(-6deg); }
.c2 { aspect-ratio: 2/3; right: 170px; top: 70px; transform: rotate(4deg) scale(0.9); opacity: 0.8; }
.c3 { aspect-ratio: 16/9; width: 160px; right: 110px; bottom: 0; transform: rotate(-2deg); opacity: 0.7; }
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 0 18px;
  gap: 16px;
}
.section-head h2 {
  font-size: 20px;
  margin: 0;
  font-weight: 700;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-faint);
  transition: border-color 0.2s;
}
.search:focus-within {
  border-color: rgba(124, 92, 255, 0.6);
}
.search input {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  width: 200px;
}
.recent {
  margin-bottom: 34px;
}
.recent-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.recent-card {
  display: flex;
  gap: 12px;
  padding: 10px;
  border-radius: 14px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  text-align: left;
  transition: all 0.18s ease;
}
.recent-card:hover {
  border-color: var(--line-strong);
  transform: translateY(-2px);
}
.recent-thumb {
  flex: 0 0 84px;
  height: 52px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.9);
  background: linear-gradient(135deg, #4b3bb3, #1e2331);
}
.recent-thumb.hevc {
  background: linear-gradient(135deg, #7c5cff, #ff5c8a);
}
.recent-meta {
  min-width: 0;
  flex: 1;
}
.recent-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.progress {
  height: 4px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.1);
  margin: 8px 0 6px;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--grad);
  border-radius: 99px;
}
.recent-sub {
  font-size: 11px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 24px 18px;
}
.card {
  text-align: left;
  padding: 0;
  background: none;
  border: none;
  display: block;
}
.poster-wrap {
  position: relative;
  border-radius: 14px;
  transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.25s;
  box-shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.9);
}
.card:hover .poster-wrap {
  transform: translateY(-6px) scale(1.02);
  box-shadow: 0 24px 50px -24px rgba(124, 92, 255, 0.6);
}
.hover-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: rgba(11, 13, 18, 0.5);
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s;
}
.card:hover .hover-play {
  opacity: 1;
}
.count-chip {
  position: absolute;
  left: 8px;
  bottom: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.card-title {
  margin-top: 12px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-sub {
  font-size: 12px;
  margin-top: 4px;
}
.card.sk {
  pointer-events: none;
}
.notice {
  padding: 14px 16px;
  border-radius: 12px;
  margin-bottom: 20px;
  font-size: 14px;
}
.notice.err {
  background: rgba(255, 92, 108, 0.1);
  border: 1px solid rgba(255, 92, 108, 0.3);
  color: #ffc2c8;
}
.empty {
  text-align: center;
  padding: 80px 20px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
}
.empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
}
@media (max-width: 900px) {
  .hero {
    grid-template-columns: 1fr;
    padding-top: 20px;
  }
  .hero-art {
    display: none;
  }
  .stats {
    flex-wrap: wrap;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 18px 12px;
  }
}
</style>
