<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import Icon from '../components/Icon.vue'
import { api, fmtSize, fmtDate, parseEpisode, prettyTitle } from '../api'
const props = defineProps({ path: { type: String, default: '/' }, library: { type: String, default: '' } })
const router = useRouter()
const loading = ref(true)
const error = ref('')
const items = ref([])
const libraryId = ref(props.library)
const libraryName = ref('媒体库')
let savedView = 'grid'
try { savedView = localStorage.getItem('anishare.view') || 'grid' } catch {}
const view = ref(savedView === 'list' ? 'list' : 'grid')
const keyword = ref('')
let requestId = 0
watch(() => [props.path, props.library], load, { immediate: true })
async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const data = await api.list(props.path, props.library)
    if (id === requestId) {
      items.value = data.items
      libraryId.value = data.libraryId
      libraryName.value = data.libraryName || '媒体库'
    }
  }
  catch (e) { if (id === requestId) { error.value = e.message; items.value = [] } }
  finally { if (id === requestId) loading.value = false }
}
function setView(v) { view.value = v; try { localStorage.setItem('anishare.view', v) } catch {} }
function go(p) { router.push({ name: 'browse', query: { path: p, library: libraryId.value || props.library } }) }
const decodedPath = computed(() => { try { return decodeURIComponent(props.path) } catch { return props.path } })
const crumbs = computed(() => {
  const out = [{ name: libraryName.value, path: '/' }]
  let acc = ''
  for (const segment of decodedPath.value.split('/').filter(Boolean)) { acc += '/' + encodeURIComponent(segment); out.push({ name: segment, path: acc }) }
  return out
})
const parent = computed(() => crumbs.value.length > 1 ? crumbs.value[crumbs.value.length - 2].path : '/')
const folders = computed(() => items.value.filter(i => i.kind === 'dir'))
const videos = computed(() => items.value.filter(i => i.kind === 'video'))
const others = computed(() => items.value.filter(i => !['dir', 'video'].includes(i.kind)))
function filterBy(list) { const k = keyword.value.trim().toLowerCase(); return k ? list.filter(i => i.name.toLowerCase().includes(k)) : list }
const filteredFolders = computed(() => filterBy(folders.value))
const filteredVideos = computed(() => filterBy(videos.value))
const filteredOthers = computed(() => filterBy(others.value))
const noMatches = computed(() => !filteredFolders.value.length && !filteredVideos.value.length && !filteredOthers.value.length)
function open(item) {
  if (item.kind === 'dir') go(item.path)
  else if (item.kind === 'video') router.push({ name: 'watch', query: { path: item.path, library: libraryId.value } })
  else window.open(api.fileUrl(item.path, libraryId.value), '_blank', 'noopener,noreferrer')
}
function epOf(item, index) { const e = parseEpisode(item.name); return String(e.episode || index + 1).padStart(2, '0') }
const totalSize = computed(() => videos.value.reduce((n, v) => n + (v.size || 0), 0))
</script>
<template>
  <div class="browse container">
    <div class="toolbar"><button class="icon-button" :disabled="decodedPath === '/'" aria-label="返回上一级目录" @click="go(parent)"><Icon name="chevron-left" :size="17" /></button><nav class="crumbs" aria-label="目录导航"><template v-for="(c,i) in crumbs" :key="c.path"><button class="crumb" :class="{ last:i === crumbs.length - 1 }" :aria-current="i === crumbs.length - 1 ? 'page' : undefined" @click="go(c.path)">{{ c.name }}</button><span v-if="i < crumbs.length - 1" class="sep">/</span></template></nav><div class="tools"><label class="search"><Icon name="search" :size="14" /><input v-model="keyword" type="search" aria-label="筛选当前目录" placeholder="筛选文件" /></label><div class="views"><button :class="{on:view === 'grid'}" :aria-pressed="view === 'grid'" title="海报视图" aria-label="海报视图" @click="setView('grid')"><Icon name="grid" :size="14" /></button><button :class="{on:view === 'list'}" :aria-pressed="view === 'list'" title="列表视图" aria-label="列表视图" @click="setView('list')"><Icon name="list" :size="15" /></button></div><button class="icon-button" aria-label="刷新目录" title="刷新" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /></button></div></div>
    <div class="summary"><span v-if="folders.length">{{ folders.length }} 个文件夹</span><span v-if="videos.length">{{ videos.length }} 个视频</span><span v-if="totalSize">{{ fmtSize(totalSize) }}</span><span v-if="others.length">{{ others.length }} 个字幕及其他文件</span></div>
    <div v-if="error" class="notice err" role="alert"><span>{{ error }}</span><button class="btn small ghost" @click="load">重试</button><router-link class="btn small ghost" :to="{ name: 'library' }">媒体库</router-link></div>
    <div v-if="loading" class="folder-grid" aria-label="正在读取目录" aria-busy="true"><div v-for="i in 12" :key="i" class="skeleton sk-card" /></div>
    <template v-else>
      <section v-if="filteredFolders.length" class="group"><h2 v-if="videos.length || others.length">文件夹</h2><div v-if="view === 'grid'" class="folder-grid"><button v-for="(f, i) in filteredFolders" :key="f.path" class="folder-card" data-gp-card :data-gp-autofocus="i === 0 ? '' : undefined" @click="open(f)" :title="f.name"><div class="folder-poster"><Poster :name="f.name" :poster="f.poster || ''" :library="libraryId" /><span v-if="f.count" class="count-chip">{{ f.count }} 集</span></div><div class="folder-name">{{ f.name }}</div></button></div><div v-else class="rows"><button v-for="(f, i) in filteredFolders" :key="f.path" class="row" data-gp-card :data-gp-autofocus="i === 0 ? '' : undefined" @click="open(f)"><span class="row-icon"><Icon name="folder" :size="18" /></span><span class="row-name">{{ f.name }}</span><span class="row-meta">{{ f.count ? f.count + ' 集' : '空' }}</span><Icon name="chevron-right" :size="14" /></button></div></section>
      <section v-if="filteredVideos.length" class="group"><h2>剧集</h2><div v-if="view === 'grid'" class="video-grid"><button v-for="(v,i) in filteredVideos" :key="v.path" class="video-card" data-gp-card :data-gp-autofocus="i === 0 ? '' : undefined" @click="open(v)" :title="v.name"><div class="thumb"><span class="ep">{{ epOf(v,i) }}</span><Icon name="play" :size="21" /><span class="ext">{{ v.ext.replace('.', '').toUpperCase() }}</span></div><div class="v-title">{{ prettyTitle(v.name) }}</div><div class="v-sub">{{ fmtSize(v.size) }}</div></button></div><div v-else class="rows"><button v-for="(v,i) in filteredVideos" :key="v.path" class="row" data-gp-card :data-gp-autofocus="i === 0 ? '' : undefined" @click="open(v)" :title="v.name"><span class="row-no">{{ epOf(v,i) }}</span><span class="row-name">{{ prettyTitle(v.name) }}</span><span class="row-meta">{{ fmtSize(v.size) }}</span><span class="row-date">{{ fmtDate(v.mtime) }}</span><Icon name="play" :size="14" /></button></div></section>
      <section v-if="filteredOthers.length" class="group"><h2>字幕 / 其他</h2><div class="rows"><button v-for="f in filteredOthers" :key="f.path" class="row" data-gp-card @click="open(f)" :title="f.name"><span class="row-icon subtitle">{{ f.kind === 'audio' ? '♫' : 'CC' }}</span><span class="row-name">{{ f.name }}</span><span class="row-meta">{{ fmtSize(f.size) }}</span><Icon name="arrow-up-right" :size="14" /></button></div></section>
      <div v-if="noMatches && !error" class="empty"><div class="empty-icon"><Icon :name="keyword ? 'search' : 'folder'" :size="25" /></div><h3>{{ keyword ? '没有匹配的文件' : '这个目录里没有可播放的内容' }}</h3><p class="muted">{{ keyword ? '换个关键词试试。' : '支持 MKV、MP4 等视频和 ASS、SRT、VTT 字幕。' }}</p><button v-if="keyword" class="btn small" @click="keyword = ''">清除筛选</button></div>
    </template>
  </div>
</template>
<style scoped>
.browse { padding: 13px 0 30px; }.toolbar { display: flex; align-items: center; gap: 8px; min-height: 30px; margin-bottom: 8px; }.icon-button { display: grid; place-items: center; padding: 0; width: 28px; height: 28px; flex: none; color: var(--text-dim); border-radius: 5px; }.icon-button:hover { color: var(--accent); background: var(--bg-elev); }.icon-button:disabled { opacity: .3; }.crumbs { display: flex; gap: 4px; align-items: center; min-width: 0; flex-wrap: wrap; }.crumb { font-size: 11px; color: var(--text-faint); padding: 5px 4px; border-radius: 4px; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.crumb:hover { color: var(--accent); }.crumb.last { color: var(--text); }.sep { font-size: 10px; color: #474453; }.tools { display: flex; gap: 7px; align-items: center; margin-left: auto; flex: none; }.search { display: flex; align-items: center; gap: 7px; width: 180px; height: 28px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 5px; color: var(--text-faint); background: var(--bg-elev); }.search input { width: 100%; min-width: 0; font-size: 11px; background: transparent; border: none; outline: none; color: var(--text); }.search:focus-within { border-color: #a78bfa66; }.views { display: flex; border: 1px solid var(--line-strong); border-radius: 5px; overflow: hidden; }.views button { display: grid; place-items: center; width: 29px; height: 26px; padding: 0; color: var(--text-faint); }.views button.on { color: var(--accent); background: #a78bfa12; }.summary { display: flex; flex-wrap: wrap; gap: 13px; min-height: 16px; margin: 0 0 13px 3px; color: var(--text-faint); font-size: 10px; }.group { margin-bottom: 22px; }h2 { font-size: 11px; color: var(--text-dim); font-weight: 500; margin: 0 0 11px; }.folder-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(125px,1fr)); gap: 14px 10px; }.folder-card, .video-card { padding: 0; text-align: left; min-width: 0; }.folder-poster { position: relative; border-radius: 5px; overflow: hidden; outline: 1px solid var(--line); }.folder-card:is(:hover, [data-gp-focused]) .folder-poster { outline-color: #a78bfa77; }.count-chip { position: absolute; right: 4px; bottom: 4px; padding: 2px 4px; border-radius: 3px; font-size: 9px; background: #09090dbb; }.folder-name, .v-title { margin-top: 6px; font-size: 11px; line-height: 1.55; color: #c5c2d0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.folder-card:is(:hover, [data-gp-focused]) .folder-name, .video-card:is(:hover, [data-gp-focused]) .v-title { color: var(--accent); }.video-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(155px,1fr)); gap: 15px 10px; }.thumb { display: grid; place-items: center; position: relative; aspect-ratio: 16/9; border-radius: 5px; overflow: hidden; background: #14121d; border: 1px solid #a78bfa13; color: #a78bfa88; }.video-card:is(:hover, [data-gp-focused]) .thumb { border-color: #a78bfa66; color: #cfbaff; }.ep { position: absolute; top: 8px; left: 9px; color: #a78bfa77; font: 15px ui-monospace,monospace; }.ext { position: absolute; right: 5px; bottom: 5px; font: 8px ui-monospace,monospace; color: var(--text-faint); }.v-sub { margin-top: 3px; color: var(--text-faint); font-size: 9px; }.rows { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }.row { width: 100%; display: flex; align-items: center; gap: 12px; min-height: 42px; padding: 7px 12px; border-bottom: 1px solid var(--line); text-align: left; }.row:last-child { border-bottom: none; }.row:is(:hover, [data-gp-focused]) { background: #a78bfa08; }.row > svg { flex: none; color: var(--text-faint); }.row-icon { display: grid; place-items: center; width: 22px; flex: none; color: var(--accent); }.subtitle { font-size: 10px; font-weight: 600; }.row-no { width: 23px; flex: none; color: var(--accent); font: 11px ui-monospace,monospace; }.row-name { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--text-dim); }.row-meta, .row-date { color: var(--text-faint); font-size: 10px; white-space: nowrap; }.sk-card { aspect-ratio: 2/3; }
@media(max-width:1000px) and (min-width:601px) { .folder-grid { grid-template-columns: repeat(auto-fill,minmax(100px,1fr)); gap: 12px 8px; } }
@media(max-width:700px) { .toolbar { flex-wrap: wrap; gap: 4px; }.crumbs { flex: 1; }.crumb { max-width: 200px; }.tools { flex-basis: 100%; padding-top: 7px; }.search { flex: 1; }.summary { margin-top: 10px; }.row-date { display: none; } }
@media(max-width:600px) { .folder-grid { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px 8px; }.video-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 13px 8px; }.folder-name, .v-title { font-size: 10px; }.row { gap: 8px; padding: 8px; }.row-meta { font-size: 9px; } }
@media(max-width:370px) { .folder-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }

/* 手柄选中态细节：封面描边 / 标题提亮，列表行背景提亮 */
html.gp-mode .folder-card[data-gp-focused] .folder-poster { outline-color: #e2d7ff; }
html.gp-mode .video-card[data-gp-focused] .thumb { border-color: #c4b5fd; color: #e4d9ff; }
.folder-card[data-gp-focused] .folder-name, .video-card[data-gp-focused] .v-title { color: #f0e9ff; }
.row[data-gp-focused] { background: #a78bfa14; }
/* 列表行外层 .rows 有 overflow: hidden，改内嵌高亮环并取消放大，避免文字被裁切 */
html.gp-mode .row[data-gp-focused] { transform: none; outline-offset: -2px; box-shadow: inset 0 0 0 1px #c4b5fd99, 0 0 26px #a78bfa33; }
</style>
