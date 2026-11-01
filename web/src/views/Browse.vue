<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import { api, fmtSize, fmtDate, parseEpisode, prettyTitle } from '../api'

const props = defineProps({ path: { type: String, default: '/' } })
const router = useRouter()

const loading = ref(true)
const error = ref('')
const items = ref([])
const root = ref('')
const view = ref(localStorage.getItem('anishare.view') || 'grid')
const keyword = ref('')

watch(
  () => props.path,
  load,
  { immediate: true },
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.list(props.path)
    items.value = data.items
    root.value = data.root
  } catch (e) {
    error.value = e.message
    items.value = []
  } finally {
    loading.value = false
  }
}

function setView(v) {
  view.value = v
  localStorage.setItem('anishare.view', v)
}

function go(p) {
  router.push({ name: 'browse', query: { path: p } })
}

const decodedPath = computed(() => {
  try {
    return decodeURIComponent(props.path)
  } catch {
    return props.path
  }
})

const crumbs = computed(() => {
  const segs = decodedPath.value.split('/').filter(Boolean)
  const out = [{ name: '根目录', path: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += '/' + encodeURIComponent(s)
    out.push({ name: s, path: acc })
  }
  return out
})

const folders = computed(() => items.value.filter((i) => i.kind === 'dir'))
const videos = computed(() => items.value.filter((i) => i.kind === 'video'))
const others = computed(() => items.value.filter((i) => !['dir', 'video'].includes(i.kind)))

const filteredFolders = computed(() => filterBy(folders.value))
const filteredVideos = computed(() => filterBy(videos.value))
const filteredOthers = computed(() => filterBy(others.value))

function filterBy(list) {
  const k = keyword.value.trim().toLowerCase()
  return k ? list.filter((i) => i.name.toLowerCase().includes(k)) : list
}

function open(item) {
  if (item.kind === 'dir') go(item.path)
  else if (item.kind === 'video') router.push({ name: 'watch', query: { path: item.path } })
  else window.open(api.fileUrl(item.path), '_blank')
}

function epOf(item) {
  const e = parseEpisode(item.name)
  return e.episode ? `EP${String(e.episode).padStart(2, '0')}` : ''
}

const totalSize = computed(() => videos.value.reduce((n, v) => n + (v.size || 0), 0))
</script>

<template>
  <div class="browse container">
    <div class="crumb-bar">
      <button class="btn small ghost back" :disabled="decodedPath === '/' " @click="router.back()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <nav class="crumbs">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <button class="crumb" :class="{ last: i === crumbs.length - 1 }" @click="go(c.path)">{{ c.name }}</button>
          <span v-if="i < crumbs.length - 1" class="sep">/</span>
        </template>
      </nav>
      <div class="spacer" />
      <div class="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input v-model="keyword" placeholder="筛选当前目录…" />
      </div>
      <div class="views">
        <button :class="{ on: view === 'grid' }" @click="setView('grid')" title="海报视图">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>
        </button>
        <button :class="{ on: view === 'list' }" @click="setView('list')" title="列表视图">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
      </div>
    </div>

    <div class="summary faint">
      <span>{{ folders.length }} 个文件夹</span>
      <span v-if="videos.length">· {{ videos.length }} 个视频</span>
      <span v-if="totalSize">· {{ fmtSize(totalSize) }}</span>
      <span v-if="others.length">· {{ others.length }} 个字幕/其他文件</span>
    </div>

    <div v-if="error" class="notice err">{{ error }}</div>

    <div v-if="loading" class="grid">
      <div v-for="i in 10" :key="i" class="skeleton sk-card" />
    </div>

    <template v-else>
      <!-- 文件夹 -->
      <section v-if="filteredFolders.length" class="group">
        <div v-if="videos.length" class="group-title">文件夹</div>
        <div class="grid" v-if="view === 'grid'">
          <button v-for="f in filteredFolders" :key="f.path" class="folder-card" @click="open(f)">
            <div class="folder-poster">
              <Poster :name="f.name" :poster="f.poster || ''" wide />
              <span v-if="f.count" class="folder-count">{{ f.count }} 集</span>
            </div>
            <div class="folder-name">{{ f.name }}</div>
          </button>
        </div>
        <div v-else class="rows">
          <button v-for="f in filteredFolders" :key="f.path" class="row" @click="open(f)">
            <span class="icon dir">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2z"/></svg>
            </span>
            <span class="row-name">{{ f.name }}</span>
            <span class="row-meta faint">{{ f.count ? f.count + ' 集视频' : '空' }}</span>
            <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        </div>
      </section>

      <!-- 视频 -->
      <section v-if="filteredVideos.length" class="group">
        <div class="group-title">剧集</div>
        <div class="video-grid">
          <button v-for="v in filteredVideos" :key="v.path" class="video-card" @click="open(v)" :title="v.name">
            <div class="thumb">
              <div class="thumb-bg" />
              <span v-if="epOf(v)" class="ep">{{ epOf(v) }}</span>
              <span class="play">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
              </span>
              <span class="ext">{{ v.ext.replace('.', '').toUpperCase() }}</span>
            </div>
            <div class="v-title">{{ prettyTitle(v.name) }}</div>
            <div class="v-sub faint">{{ fmtSize(v.size) }}<template v-if="v.mtime"> · {{ fmtDate(v.mtime) }}</template></div>
          </button>
        </div>
      </section>

      <!-- 字幕等其它文件 -->
      <section v-if="filteredOthers.length" class="group">
        <div class="group-title">字幕 / 其它</div>
        <div class="rows">
          <button v-for="f in filteredOthers" :key="f.path" class="row" @click="open(f)">
            <span class="icon sub">CC</span>
            <span class="row-name">{{ f.name }}</span>
            <span class="row-meta faint">{{ fmtSize(f.size) }}</span>
            <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M9 7h8v8"/></svg>
          </button>
        </div>
      </section>

      <div v-if="!items.length" class="empty">
        <div class="empty-icon">🗂️</div>
        <h3>这个文件夹里没有可播放的内容</h3>
        <p class="muted">支持 mkv / mp4 / ts 等视频，以及 ass / srt / vtt 外挂字幕</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.browse {
  padding: 24px 0 80px;
}
.crumb-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.back {
  width: 32px;
  padding: 0;
  justify-content: center;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  font-size: 14px;
  color: var(--text-dim);
  padding: 4px 8px;
  border-radius: 8px;
}
.crumb:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}
.crumb.last {
  color: var(--text);
  font-weight: 600;
}
.sep {
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-faint);
}
.search input {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  width: 160px;
}
.views {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.views button {
  width: 34px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--text-faint);
}
.views button.on {
  background: var(--bg-elev-2);
  color: var(--text);
}
.summary {
  font-size: 13px;
  display: flex;
  gap: 6px;
  margin-bottom: 24px;
}
.group {
  margin-bottom: 34px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 1px;
  margin-bottom: 14px;
  text-transform: uppercase;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 18px;
}
.sk-card {
  height: 150px;
}
.folder-card {
  text-align: left;
  padding: 0;
}
.folder-poster {
  position: relative;
  transition: transform 0.2s;
}
.folder-card:hover .folder-poster {
  transform: translateY(-3px);
}
.folder-count {
  position: absolute;
  right: 8px;
  top: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.folder-name {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 18px;
}
.video-card {
  text-align: left;
  padding: 0;
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  transition: all 0.2s;
}
.thumb-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 120% at 0% 0%, rgba(124, 92, 255, 0.35), transparent 55%),
    radial-gradient(120% 120% at 100% 100%, rgba(255, 92, 138, 0.22), transparent 55%),
    linear-gradient(160deg, #1a1e2a, #10131a);
}
.video-card:hover .thumb {
  border-color: rgba(124, 92, 255, 0.55);
  transform: translateY(-3px);
  box-shadow: 0 18px 40px -24px rgba(124, 92, 255, 0.9);
}
.play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  opacity: 0.85;
  transition: transform 0.2s;
}
.video-card:hover .play {
  transform: scale(1.12);
}
.ep {
  position: absolute;
  left: 10px;
  top: 9px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(124, 92, 255, 0.28);
  border: 1px solid rgba(124, 92, 255, 0.5);
}
.ext {
  position: absolute;
  right: 9px;
  bottom: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.6px;
  color: rgba(255, 255, 255, 0.7);
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.45);
}
.v-title {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.v-sub {
  font-size: 12px;
  margin-top: 4px;
}
.rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.02);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  transition: background 0.15s;
}
.row:last-child {
  border-bottom: none;
}
.row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex: none;
}
.icon.dir {
  color: #ffd479;
  background: rgba(255, 212, 121, 0.12);
}
.icon.sub {
  font-size: 11px;
  font-weight: 800;
  color: #8fe3ff;
  background: rgba(143, 227, 255, 0.1);
  border: 1px solid rgba(143, 227, 255, 0.25);
}
.row-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  font-size: 12px;
  white-space: nowrap;
}
.chev {
  color: var(--text-faint);
  flex: none;
}
.notice {
  padding: 14px 16px;
  border-radius: 12px;
  margin-bottom: 20px;
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
@media (max-width: 720px) {
  .search {
    display: none;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .video-grid {
    grid-template-columns: 1fr;
  }
}
</style>
