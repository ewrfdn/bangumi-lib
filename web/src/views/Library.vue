<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import Icon from '../components/Icon.vue'
import { api, mediaCoverUrl, prettyTitle } from '../api'
import { useGamepadContext } from '../gamepad/useGamepad.js'

const props = defineProps({ library: { type: String, default: '' } })
const router = useRouter()
const loading = ref(true)
const error = ref('')
const libraries = ref([])
const defaultLibraryId = ref('')
const selectedId = ref('')
const data = ref(null)
const keyword = ref('')
const sort = ref('name')
let requestId = 0
const selectedLibrary = computed(() => libraries.value.find(item => item.id === selectedId.value))
const series = computed(() => data.value?.series || [])
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const result = series.value.filter(s => !k || s.name.toLowerCase().includes(k))
  result.sort(sort.value === 'count'
    ? (a, b) => (b.count || 0) - (a.count || 0)
    : (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return result
})
const videoCount = computed(() => series.value.reduce((count, item) => count + (item.count || 0), 0))
watch(() => props.library, () => { keyword.value = ''; load() }, { immediate: true })

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const sources = await api.libraries()
    if (id !== requestId) return
    libraries.value = sources.libraries
    defaultLibraryId.value = sources.defaultLibraryId || sources.libraries[0]?.id || ''
    selectedId.value = props.library || defaultLibraryId.value
    data.value = null
    if (!selectedId.value) return
    const result = await api.library(selectedId.value)
    if (id !== requestId) return
    data.value = result
    error.value = result.error || ''
  } catch (e) {
    if (id === requestId) { data.value = null; error.value = e.message }
  } finally {
    if (id === requestId) loading.value = false
  }
}
function selectLibrary(id) {
  router.replace({ name: 'library', query: { library: id } })
}
function shiftLibrary(step) {
  if (!libraries.value.length) return
  const index = libraries.value.findIndex(item => item.id === selectedId.value)
  const next = libraries.value[(Math.max(0, index) + step + libraries.value.length) % libraries.value.length]
  if (next && next.id !== selectedId.value) selectLibrary(next.id)
}
// 手柄：LB/RB 切换媒体库，提示条随页面变化
useGamepadContext({
  id: 'library',
  hints: { 'prev-tab': '上一个媒体库', 'next-tab': '下一个媒体库', search: '搜索番剧' },
  handle(action) {
    if (action === 'prev-tab') { shiftLibrary(-1); return true }
    if (action === 'next-tab') { shiftLibrary(1); return true }
    return false
  },
})
function openSeries(series) {
  router.push({
    name: series.kind === 'video' ? 'watch' : 'series',
    query: { path: series.path, library: series.libraryId || selectedId.value },
  })
}
</script>

<template>
  <div class="library-page container">
    <div class="page-heading">
      <div class="page-title"><h1>媒体库</h1><span v-if="!loading">{{ series.length }} 部作品 · {{ videoCount }} 个视频</span></div>
      <router-link v-if="selectedId" :to="{ name: 'browse', query: { library: selectedId, path: '/' } }" class="browse-link"><Icon name="folder" :size="15" />文件浏览<Icon name="chevron-right" :size="13" /></router-link>
    </div>
    <div class="library-toolbar">
      <div class="library-tabs" role="group" aria-label="切换媒体库">
        <button v-for="source in libraries" :key="source.id" class="library-tab" :class="{ active: source.id === selectedId, unavailable: source.available === false }" :aria-pressed="source.id === selectedId" @click="selectLibrary(source.id)"><Icon name="folder" :size="14" /><span>{{ source.name }}</span><span v-if="source.available === false" class="unavailable-dot" title="目录未连接" /></button>
      </div>
      <div class="tools"><label class="search"><Icon name="search" :size="16" /><input v-model="keyword" type="search" aria-label="搜索当前媒体库" placeholder="搜索番剧" /></label><select v-model="sort" aria-label="排序"><option value="name">名称排序</option><option value="count">集数排序</option></select><button class="refresh-button" :disabled="loading" aria-label="刷新媒体库" title="刷新" @click="load"><Icon name="refresh" :size="16" /></button></div>
    </div>
    <div v-if="error" class="notice err" role="alert"><span>{{ error }}</span><button class="btn small ghost" @click="load">重试</button></div>
    <div v-if="loading" class="poster-grid" aria-label="正在加载媒体库" aria-busy="true"><div v-for="i in 16" :key="i"><div class="skeleton poster-skeleton" /><div class="skeleton text-skeleton" /></div></div>
    <div v-else-if="!filtered.length" class="empty">
      <div class="empty-icon"><Icon :name="keyword ? 'search' : 'folder'" :size="27" /></div>
      <h3>{{ keyword ? '没有匹配的番剧' : selectedLibrary?.available === false ? '媒体库暂时未连接' : '这个媒体库还没有视频' }}</h3>
      <p class="muted">{{ keyword ? '换个关键词，或切换其他媒体库。' : selectedLibrary?.available === false ? '请检查该媒体库目录是否存在，以及磁盘是否已挂载。' : '将视频放入该媒体库目录后刷新。' }}</p>
      <button v-if="keyword" class="btn small" @click="keyword = ''">清除搜索</button><button v-else class="btn small" @click="load">刷新媒体库</button>
      <p v-if="!keyword && (data?.root || selectedLibrary?.root)" class="media-root mono">{{ data?.root || selectedLibrary?.root }}</p>
    </div>
    <div v-else class="poster-grid">
      <button v-for="(s, index) in filtered" :key="s.path" class="poster-card" data-gp-card :data-gp-autofocus="index === 0 ? '' : undefined" @click="openSeries(s)" :title="s.name">
        <div class="poster-wrap"><Poster :name="s.mediaCount > 1 ? s.name : s.media?.title || s.name" :src="s.media?.cover ? mediaCoverUrl(s.media.cover, s.libraryId || selectedId) : s.localCover ? mediaCoverUrl(s.localCover, s.libraryId || selectedId) : ''" :poster="s.poster || ''" :library="s.libraryId || selectedId" /><div class="hover-play"><span><Icon name="play" :size="24" /></span></div><span v-if="s.count" class="count-chip">{{ s.count }} 集</span><span v-if="s.mediaCount > 1" class="season-chip">{{ s.mediaCount }} 季</span></div>
        <div class="poster-title">{{ prettyTitle(s.mediaCount > 1 ? s.name : s.media?.title || s.name) }}</div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.library-page { padding: 24px 0 40px; }
.page-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 21px; }
.page-title { display: flex; align-items: baseline; gap: 13px; }.page-title h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.5px; }.page-title > span { font-size: 12px; color: var(--text-faint); }
.browse-link { display: flex; align-items: center; gap: 7px; color: var(--text-dim); font-size: 12px; }.browse-link:hover { color: var(--accent); }
.library-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 22px; padding-bottom: 15px; border-bottom: 1px solid var(--line); }
.library-tabs { display: flex; align-items: center; gap: 6px; overflow-x: auto; min-width: 0; scrollbar-width: thin; }
.library-tab { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid transparent; border-radius: 7px; color: var(--text-faint); font-size: 12px; white-space: nowrap; }.library-tab:hover { color: var(--text); background: #ffffff04; }.library-tab.active { color: #ccb9fc; background: #a78bfa12; border-color: #a78bfa25; }.library-tab.unavailable:not(.active) { color: #8c7f87; }.unavailable-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--err); }
.tools { display: flex; gap: 8px; align-items: center; flex: none; }.search { display: flex; align-items: center; gap: 8px; height: 33px; width: 220px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg-elev); color: var(--text-faint); }.search:focus-within { border-color: #a78bfa66; }.search input { background: transparent; border: none; outline: none; color: var(--text); width: 100%; min-width: 0; font-size: 12px; }.tools select { height: 33px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg-elev); color: var(--text-dim); font-size: 12px; }.refresh-button { width: 33px; height: 33px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--text-dim); }.refresh-button:hover { color: var(--accent); background: var(--bg-elev); }.refresh-button:disabled { opacity: .4; }
.poster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); gap: 22px 12px; }.poster-card { padding: 0; min-width: 0; text-align: left; }.poster-wrap { position: relative; overflow: hidden; border-radius: 6px; outline: 1px solid var(--line); }.poster-card:is(:hover, [data-gp-focused]) .poster-wrap { outline-color: #a78bfa77; }.count-chip { position: absolute; right: 5px; bottom: 5px; padding: 2px 5px; border-radius: 3px; color: #eeecf8; font-size: 10px; line-height: 1.6; background: #09090dcc; }.season-chip { position: absolute; top: 5px; left: 5px; padding: 2px 5px; border-radius: 3px; color: #d8c8ff; font-size: 9px; line-height: 1.6; background: #09090dcc; }.poster-title { margin-top: 8px; color: #ccc9d7; font-size: 12px; line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.poster-card:is(:hover, [data-gp-focused]) .poster-title { color: var(--accent); }.hover-play { position: absolute; inset: 0; display: grid; place-items: center; background: #09090d60; opacity: 0; transition: opacity .15s; }.hover-play > span { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: #a78bfadd; color: #fff; }.poster-card:is(:hover, [data-gp-focused]) .hover-play, .poster-card:focus-visible .hover-play { opacity: 1; }.poster-skeleton { aspect-ratio: 2/3; }.text-skeleton { width: 80%; height: 11px; margin-top: 8px; }.media-root { color: var(--text-faint); font-size: 11px !important; }
@media(max-width: 1050px) { .library-toolbar { flex-wrap: wrap; gap: 14px; }.library-tabs { width: 100%; }.tools { width: 100%; }.search { flex: 1; width: auto; } }
@media(max-width:1000px) and (min-width:601px) { .poster-grid { grid-template-columns: repeat(auto-fill,minmax(100px,1fr)); gap: 18px 9px; } }
@media(max-width:600px) { .library-page { padding-top: 19px; }.page-title h1 { font-size: 20px; }.page-title { gap: 9px; }.page-title > span { font-size: 11px; }.browse-link { font-size: 11px; }.library-tab { padding: 7px 10px; }.poster-grid { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 17px 9px; }.poster-title { font-size: 12px; }.library-toolbar { margin-bottom: 17px; } }
@media(max-width:370px) { .poster-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.page-title > span { display: none; } }

/* 手柄选中态细节：封面描边与标题在全局高亮环之上再提亮 */
html.gp-mode .poster-card[data-gp-focused] .poster-wrap { outline-color: #e2d7ff; }
.poster-card[data-gp-focused] .poster-title { color: #f0e9ff; }
</style>
