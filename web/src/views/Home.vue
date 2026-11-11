<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import Icon from '../components/Icon.vue'
import { api, fmtTime, mediaCoverUrl, parseEpisode, prettyTitle } from '../api'
import { getProgress, deleteProgress } from '../progress'

const router = useRouter()
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const actionError = ref('')
const libraries = ref([])
const sourcesLoaded = ref(false)
const defaultLibraryId = ref('')
const progress = ref([])
const catalogs = ref({})
const historyView = ref('all')
const historyLibrary = ref('')
const visibleCount = ref(24)
const removingKey = ref('')
const decode = (text) => { try { return decodeURIComponent(text || '') } catch { return text || '' } }
const recordKey = (item) => (item.libraryId || defaultLibraryId.value) + ':' + item.path

const records = computed(() => progress.value.filter(item => item.path).map(item => {
  const libraryId = item.libraryId || defaultLibraryId.value
  const source = libraries.value.find(source => source.id === libraryId)
  const path = decode(item.path)
  const candidates = catalogs.value[libraryId] || []
  const matched = candidates.filter(series => {
    const seriesPath = decode(series.path)
    return path === seriesPath || path.startsWith(seriesPath + '/')
  }).sort((a, b) => b.path.length - a.path.length)[0]
  const parts = path.split('/').filter(Boolean)
  const fallbackTitle = parts.length > 1 ? parts[parts.length - 2] : prettyTitle(parts[0])
  const parentPath = item.path.slice(0, item.path.lastIndexOf('/')) || '/'
  const seriesPath = item.seriesPath || matched?.path || parentPath
  const seriesTitle = item.seriesTitle || matched?.name || fallbackTitle || item.title
  const episode = parseEpisode(item.title || parts[parts.length - 1])
  const episodeLabel = episode.episode ? (episode.season ? 'S' + String(episode.season).padStart(2, '0') + ' · ' : '') + '第 ' + episode.episode + ' 集' : prettyTitle(item.title || parts[parts.length - 1])
  const duration = Math.max(0, Number(item.duration) || 0)
  const time = Math.max(0, Number(item.time) || 0)
  return {
    ...item, libraryId, seriesPath, seriesTitle, episodeLabel, time, duration,
    catalogPath: matched?.path || '',
    cover: matched?.media?.cover ? mediaCoverUrl(matched.media.cover, libraryId) : '',
    poster: item.poster || matched?.poster || '',
    sourceName: source?.name || item.libraryName || libraryId || '媒体库',
    sourceUnavailable: sourcesLoaded.value && (!source || source.available === false),
    sourceStatus: sourcesLoaded.value && !source ? '已移除' : source?.available === false ? '未连接' : '',
    seriesKind: matched?.kind || (seriesPath === item.path ? 'video' : 'dir'),
    completed: duration > 0 && time >= Math.max(duration * .95, duration - 30),
    percent: duration > 0 ? Math.max(0, Math.min(100, time / duration * 100)) : 0,
  }
}).sort((a, b) => b.at - a.at))
const unfinished = computed(() => records.value.filter(item => item.time > 5 && item.duration > 0 && !item.completed))
const continuing = computed(() => unfinished.value.slice(0, 6))
const recentSeries = computed(() => {
  const seen = new Set()
  return records.value.filter(item => {
    const key = item.libraryId + ':' + item.seriesPath
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
})
const historyItems = computed(() => records.value.filter(item =>
  (!historyLibrary.value || item.libraryId === historyLibrary.value) &&
  (historyView.value === 'all' || (historyView.value === 'completed' ? item.completed : !item.completed)),
))
const historyGroups = computed(() => {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const groups = [{ label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] }]
  for (const item of historyItems.value.slice(0, visibleCount.value)) {
    groups[item.at >= today.getTime() ? 0 : item.at >= yesterday.getTime() ? 1 : 2].items.push(item)
  }
  return groups.filter(group => group.items.length)
})
watch([historyView, historyLibrary], () => { visibleCount.value = 24 })

async function load() {
  refreshing.value = true
  error.value = ''
  const [sources, history] = await Promise.allSettled([api.libraries(), getProgress()])
  if (sources.status === 'fulfilled') {
    libraries.value = sources.value.libraries
    sourcesLoaded.value = true
    defaultLibraryId.value = sources.value.defaultLibraryId || libraries.value[0]?.id || ''
  } else error.value = sources.reason.message
  if (history.status === 'fulfilled') progress.value = history.value
  else error.value = error.value || history.reason.message
  const ids = [...new Set(progress.value.map(item => item.libraryId || defaultLibraryId.value))]
    .filter(id => id && libraries.value.some(source => source.id === id && source.available !== false))
  const results = await Promise.allSettled(ids.map(id => api.library(id)))
  const nextCatalogs = { ...catalogs.value }
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') nextCatalogs[ids[index]] = result.value.series || []
  })
  catalogs.value = nextCatalogs
  loading.value = false
  refreshing.value = false
}
onMounted(load)
function openRecord(item) {
  router.push({ name: 'watch', query: { library: item.libraryId, path: item.path, t: item.completed ? 0 : Math.floor(item.time) } })
}
function seriesLink(item) {
  if (item.seriesKind === 'video') return { name: 'watch', query: { library: item.libraryId, path: item.seriesPath } }
  if (item.catalogPath) return { name: 'series', query: { library: item.libraryId, path: item.catalogPath } }
  return { name: 'browse', query: { library: item.libraryId, path: item.seriesPath } }
}
function libraryDescription(source) {
  const catalog = catalogs.value[source.id]
  const seriesCount = source.seriesCount ?? (catalog ? catalog.length : null)
  const videoCount = source.videoCount ?? (catalog ? catalog.reduce((count, item) => count + (item.count || 0), 0) : null)
  if (source.available === false) return '目录未连接'
  return [seriesCount !== null ? seriesCount + ' 部作品' : '', videoCount !== null ? videoCount + ' 个视频' : ''].filter(Boolean).join(' · ') || '已连接'
}
function watchedAt(at, short = false) {
  const date = new Date(at || 0)
  if (!Number.isFinite(date.getTime()) || !at) return ''
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  if (at >= today.getTime()) return short ? clock : '今天 ' + clock
  if (at >= yesterday.getTime()) return short ? '昨天' : '昨天 ' + clock
  return (date.getMonth() + 1) + '月' + date.getDate() + '日' + (short ? '' : ' ' + clock)
}
async function removeRecord(item) {
  removingKey.value = recordKey(item)
  actionError.value = ''
  try {
    await deleteProgress(item)
    progress.value = progress.value.filter(record => recordKey(record) !== recordKey(item))
  } catch (e) { actionError.value = e.message }
  finally { removingKey.value = '' }
}
</script>

<template>
  <div class="home container">
    <div class="page-heading"><h1>首页</h1><div class="page-actions"><button class="refresh-button" :disabled="refreshing" @click="load" aria-label="刷新首页" title="刷新"><Icon name="refresh" :size="16" /></button><router-link :to="{ name: 'library' }" class="btn small">浏览媒体库<Icon name="arrow-right" :size="14" /></router-link></div></div>
    <div v-if="error" class="notice err" role="alert"><span>{{ error }}</span><button class="btn small ghost" @click="load">重试</button></div>

    <section class="source-section" aria-label="媒体库">
      <div v-if="loading" class="source-grid" aria-label="正在连接媒体库" aria-busy="true"><div v-for="i in 3" :key="i" class="skeleton source-skeleton" /></div>
      <div v-else-if="libraries.length" class="source-grid">
        <router-link v-for="(source, index) in libraries" :key="source.id" data-gp-card :data-gp-autofocus="index === 0 ? '' : undefined" :to="{ name: 'library', query: { library: source.id } }" class="source-card" :class="{ unavailable: source.available === false }"><span class="source-icon"><Icon name="folder" :size="23" /></span><span class="source-copy"><strong>{{ source.name }}</strong><small>{{ libraryDescription(source) }}</small></span><Icon name="chevron-right" :size="16" /></router-link>
      </div>
      <div v-else class="source-empty"><Icon name="folder" :size="18" /><span>暂无可用的媒体库</span></div>
    </section>

    <template v-if="loading">
      <section class="home-section"><div class="skeleton heading-skeleton" /><div class="continue-row"><div v-for="i in 4" :key="i"><div class="skeleton landscape-skeleton" /><div class="skeleton text-skeleton" /></div></div></section>
      <section class="home-section"><div class="skeleton heading-skeleton" /><div class="recent-series-row"><div v-for="i in 8" :key="i" class="skeleton poster-skeleton" /></div></section>
    </template>
    <div v-else-if="!records.length" class="home-empty"><span class="home-empty-icon"><Icon name="clock" :size="30" /></span><h2>暂无观看记录</h2><p>从媒体库选一集开始观看，进度和历史会保存在这里。</p><router-link :to="{ name: 'library' }" class="btn primary"><Icon name="play" :size="15" />打开媒体库</router-link></div>
    <template v-else>
      <section class="home-section" aria-labelledby="continue-title">
        <div class="section-heading"><h2 id="continue-title">继续观看<span v-if="unfinished.length" class="section-count">{{ unfinished.length }}</span></h2><router-link class="section-link" :to="{ hash: '#watch-history' }">观看历史<Icon name="chevron-right" :size="14" /></router-link></div>
        <div v-if="continuing.length" class="continue-row">
          <button v-for="(item,index) in continuing" :key="recordKey(item)" class="continue-card" data-gp-card :class="{ latest: index === 0 }" :disabled="item.sourceUnavailable" @click="openRecord(item)" :title="item.seriesTitle + ' · ' + item.episodeLabel">
            <div class="continue-cover"><Poster :name="item.seriesTitle" :src="item.cover" :poster="item.poster" :library="item.libraryId" wide /><div class="cover-shade" /><span v-if="index === 0" class="latest-badge">上次观看</span><span class="cover-play"><Icon name="play" :size="23" /></span><span class="remaining">还剩 {{ fmtTime(Math.max(0, item.duration - item.time)) }}</span><span class="continue-progress"><span :style="{ width: item.percent + '%' }" /></span></div>
            <div class="continue-meta"><strong>{{ prettyTitle(item.seriesTitle) }}</strong><span class="continue-episode">{{ item.episodeLabel }}<small>{{ item.sourceName }}<template v-if="item.sourceStatus"> · {{ item.sourceStatus }}</template></small></span></div>
          </button>
        </div>
        <div v-else class="section-empty"><Icon name="check" :size="18" /><span>最近观看的剧集都已看完</span><router-link :to="{ name: 'library' }">浏览媒体库<Icon name="arrow-right" :size="14" /></router-link></div>
      </section>

      <section v-if="recentSeries.length" class="home-section" aria-labelledby="recent-series-title">
        <div class="section-heading"><h2 id="recent-series-title">最近看的番剧</h2></div>
        <div class="recent-series-row">
          <router-link v-for="item in recentSeries" :key="item.libraryId + ':' + item.seriesPath" :to="seriesLink(item)" class="series-card" data-gp-card :title="item.seriesTitle">
            <div class="series-cover"><Poster :name="item.seriesTitle" :src="item.cover" :poster="item.poster" :library="item.libraryId" /><span v-if="libraries.length > 1 || item.sourceStatus" class="source-badge">{{ item.sourceName }}<template v-if="item.sourceStatus"> · {{ item.sourceStatus }}</template></span><span class="series-hover"><Icon name="arrow-up-right" :size="23" /></span></div>
            <strong>{{ prettyTitle(item.seriesTitle) }}</strong><span class="series-episode">{{ item.episodeLabel }}</span><small>{{ watchedAt(item.at) }}</small>
          </router-link>
        </div>
      </section>

      <section id="watch-history" class="home-section history-section" aria-labelledby="history-title">
        <div class="section-heading history-heading"><h2 id="history-title">观看历史<span class="section-count">{{ records.length }}</span></h2><select v-if="libraries.length > 1" v-model="historyLibrary" aria-label="筛选历史的媒体库"><option value="">全部媒体库</option><option v-for="source in libraries" :key="source.id" :value="source.id">{{ source.name }}</option></select></div>
        <div class="history-tabs" role="group" aria-label="筛选观看历史"><button :class="{ active: historyView === 'all' }" :aria-pressed="historyView === 'all'" @click="historyView = 'all'">全部</button><button :class="{ active: historyView === 'unfinished' }" :aria-pressed="historyView === 'unfinished'" @click="historyView = 'unfinished'">未看完</button><button :class="{ active: historyView === 'completed' }" :aria-pressed="historyView === 'completed'" @click="historyView = 'completed'">已看完</button></div>
        <div v-if="actionError" class="notice err" role="alert">{{ actionError }}</div>
        <div v-if="!historyGroups.length" class="section-empty"><Icon name="clock" :size="18" /><span>没有符合条件的观看记录</span></div>
        <div v-for="group in historyGroups" :key="group.label" class="history-group"><h3>{{ group.label }}</h3><div class="history-list">
          <div v-for="item in group.items" :key="recordKey(item)" class="history-row">
            <button class="history-main" data-gp-card :disabled="item.sourceUnavailable" @click="openRecord(item)" :title="item.sourceName + ' · ' + item.seriesTitle + ' · ' + item.episodeLabel"><div class="history-thumb"><Poster :name="item.seriesTitle" :src="item.cover" :poster="item.poster" :library="item.libraryId" wide /><span><Icon name="play" :size="15" /></span></div><span class="history-copy"><strong>{{ prettyTitle(item.seriesTitle) }}</strong><small><span v-if="libraries.length > 1 || item.sourceStatus" class="history-mobile-source">{{ item.sourceName }} · </span>{{ item.episodeLabel }}<template v-if="item.sourceStatus"> · {{ item.sourceStatus }}</template></small></span></button>
            <span class="history-source">{{ item.sourceName }}<template v-if="item.sourceStatus"> · {{ item.sourceStatus }}</template></span><span class="history-progress" :class="{ completed: item.completed }"><Icon v-if="item.completed" name="check" :size="13" /><span>{{ item.completed ? '已看完' : fmtTime(item.time) + ' / ' + fmtTime(item.duration) }}</span></span><time class="history-time" :datetime="new Date(item.at).toISOString()">{{ watchedAt(item.at) }}</time><button class="delete-record" :disabled="removingKey === recordKey(item)" @click="removeRecord(item)" :aria-label="'删除观看记录：' + item.sourceName + ' · ' + item.seriesTitle + ' ' + item.episodeLabel" title="删除这条记录"><Icon name="close" :size="15" /></button>
          </div>
        </div></div>
        <button v-if="historyItems.length > visibleCount" class="load-more" @click="visibleCount += 24">加载更多<Icon name="chevron-right" :size="14" /></button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.history-mobile-source { display: none; }
@media(max-width:900px) { .history-mobile-source { display: inline; } }
.home { padding: 25px 0 45px; }
.page-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 22px; }.page-heading h1 { margin: 0; font-size: 23px; font-weight: 600; letter-spacing: -.5px; }.page-actions { display: flex; align-items: center; gap: 12px; }.page-actions .btn { min-height: 31px; font-size: 12px; }.refresh-button { width: 31px; height: 31px; display: grid; place-items: center; padding: 0; color: var(--text-faint); border-radius: 6px; }.refresh-button:hover { color: var(--accent); background: var(--bg-elev); }.refresh-button:disabled { opacity: .4; }
.source-section { margin-bottom: 30px; }.source-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(215px,1fr)); gap: 12px; }.source-card { display: flex; align-items: center; gap: 14px; min-height: 78px; padding: 15px 18px; border: 1px solid var(--line-strong); border-radius: 10px; background: linear-gradient(110deg,#17131f,#111116); transition: border-color .18s, background .18s; }.source-card:is(:hover, [data-gp-focused]) { border-color: #a78bfa60; background: #19151f; }.source-icon { width: 39px; height: 39px; display: grid; place-items: center; border: 1px solid #a78bfa20; border-radius: 10px; color: var(--accent); background: #a78bfa09; flex: none; }.source-copy { flex: 1; min-width: 0; }.source-copy strong { display: block; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.source-copy small { display: block; font-size: 11px; color: var(--text-faint); margin-top: 7px; }.source-card > svg { flex: none; color: var(--text-faint); }.source-card.unavailable { background: #111115; }.unavailable .source-icon { color: #958a98; border-color: #ffffff12; background: #ffffff03; }.unavailable .source-copy small { color: #bc939e; }.source-empty { display: flex; align-items: center; gap: 10px; padding: 20px; color: var(--text-faint); font-size: 13px; border: 1px solid var(--line); border-radius: 8px; }.source-skeleton { height: 78px; }
.home-section { margin-bottom: 32px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 16px; }.section-heading h2 { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 550; margin: 0; }.section-count { font-size: 11px; font-weight: 400; color: var(--text-faint); }.section-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-faint); }.section-link:hover { color: var(--accent); }
.continue-row { display: grid; grid-auto-flow: column; grid-auto-columns: calc((100% - 48px) / 4); gap: 16px; overflow-x: auto; padding: 10px 8px 10px; scrollbar-width: thin; scroll-snap-type: x proximity; }.continue-card { padding: 0; min-width: 0; text-align: left; scroll-snap-align: start; }.continue-cover { position: relative; overflow: hidden; border-radius: 9px; outline: 1px solid var(--line-strong); }.continue-cover :deep(.poster) { border-radius: 9px; }.continue-cover :deep(img) { object-position: 50% 30%; }.continue-card:disabled .continue-cover { opacity: .55; }.continue-card:disabled .cover-play { display: none; }.continue-card:disabled:hover .continue-cover { outline-color: var(--line-strong); }.continue-card.latest .continue-cover { outline-color: #a78bfa70; }.cover-shade { position: absolute; inset: 0; background: linear-gradient(180deg,#09090d16 30%,#09090d85); }.latest-badge { position: absolute; top: 9px; left: 9px; padding: 4px 7px; background: #a78bfadd; border-radius: 4px; color: #fff; font-size: 10px; }.cover-play { position: absolute; left: 50%; top: 50%; display: grid; place-items: center; width: 41px; height: 41px; border-radius: 50%; border: 1px solid #ffffff40; background: #09090d99; color: #f6f0ff; transform: translate(-50%,-50%); opacity: 0; transition: opacity .18s, background .18s; }.latest .cover-play, .continue-card:is(:hover, [data-gp-focused]) .cover-play, .continue-card:focus-visible .cover-play { opacity: 1; }.continue-card:hover .cover-play { background: #9c7cf4; border-color: #9c7cf4; }.remaining { position: absolute; right: 8px; bottom: 11px; font-size: 10px; color: #f1edf9; background: #09090d70; padding: 3px 5px; border-radius: 3px; }.continue-progress { position: absolute; bottom: 0; height: 3px; left: 0; right: 0; background: #ffffff25; }.continue-progress > span { display: block; height: 100%; background: var(--accent); }.continue-meta { padding: 11px 1px 0; }.continue-meta strong { display: block; color: var(--text); font-size: 14px; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.continue-episode { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-dim); font-size: 12px; margin-top: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.continue-episode small { color: var(--text-faint); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.recent-series-row { display: grid; grid-auto-flow: column; grid-auto-columns: calc((100% - 112px) / 9); gap: 14px; overflow-x: auto; padding: 10px 8px 10px; scrollbar-width: thin; scroll-snap-type: x proximity; }.series-card { min-width: 0; scroll-snap-align: start; }.series-cover { position: relative; border-radius: 7px; overflow: hidden; outline: 1px solid var(--line); }.series-cover :deep(.poster) { border-radius: 7px; }.series-card:is(:hover, [data-gp-focused]) .series-cover { outline-color: #a78bfa70; }.source-badge { position: absolute; bottom: 5px; right: 5px; max-width: calc(100% - 10px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 3px 5px; border-radius: 3px; font-size: 9px; color: #eeeaf8; background: #09090dba; }.series-hover { position: absolute; inset: 0; display: grid; place-items: center; background: #09090d60; color: #d6c5ff; opacity: 0; transition: opacity .15s; }.series-card:is(:hover, [data-gp-focused]) .series-hover, .series-card:focus-visible .series-hover { opacity: 1; }.series-card > strong { display: block; margin-top: 9px; font-size: 12px; line-height: 1.7; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.series-episode { display: block; font-size: 11px; line-height: 1.6; color: var(--text-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.series-card > small { display: block; color: var(--text-faint); font-size: 10px; margin-top: 4px; }
.history-section { padding-top: 5px; scroll-margin-top: 20px; }.history-heading { margin-bottom: 15px; }.history-heading select { padding: 6px 8px; font-size: 12px; color: var(--text-dim); background: var(--bg-elev); border: 1px solid var(--line-strong); border-radius: 5px; }.history-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--line); margin-bottom: 21px; }.history-tabs button { position: relative; padding: 0 2px 13px; color: var(--text-faint); font-size: 12px; }.history-tabs button.active { color: var(--accent); }.history-tabs button.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--accent); }.history-group { margin-bottom: 21px; }.history-group > h3 { font-size: 11px; color: var(--text-faint); font-weight: 500; margin: 0 0 9px 1px; }.history-list { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: #101016; }.history-row { display: grid; grid-template-columns: minmax(0,1fr) 130px 140px 130px 27px; align-items: center; gap: 22px; min-height: 75px; padding: 10px 15px; border-bottom: 1px solid var(--line); }.history-row:last-child { border-bottom: none; }.history-row:hover { background: #a78bfa04; }.history-main { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 0; text-align: left; }.history-thumb { position: relative; width: 82px; flex: none; overflow: hidden; border-radius: 5px; }.history-thumb > span { position: absolute; inset: 0; display: grid; place-items: center; background: #09090d35; color: #eeeaf8; opacity: 0; }.history-main:disabled { opacity: .6; }.history-main:disabled .history-thumb > span { display: none; }.history-main:hover .history-thumb > span { opacity: 1; }.history-copy { min-width: 0; }.history-copy strong { display: block; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.history-copy small { display: block; color: var(--text-faint); font-size: 11px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.history-source { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.history-progress { display: flex; align-items: center; gap: 4px; font: 11px ui-monospace,monospace; color: var(--text-dim); white-space: nowrap; }.history-progress.completed { color: #a89bbf; font-family: inherit; }.history-time { font-size: 11px; color: var(--text-faint); white-space: nowrap; text-align: right; }.delete-record { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; color: var(--text-faint); border-radius: 5px; opacity: 0; }.history-row:hover .delete-record, .delete-record:focus-visible { opacity: 1; }.delete-record:hover { color: #e6a2ae; background: #e594a10b; }.delete-record:disabled { opacity: .35; }.load-more { margin: 0 auto; display: flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 18px; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--text-dim); font-size: 12px; }.load-more:hover { color: var(--accent); border-color: #a78bfa44; }
.section-empty { display: flex; align-items: center; gap: 11px; padding: 23px 18px; color: var(--text-faint); font-size: 12px; border: 1px dashed var(--line-strong); border-radius: 8px; }.section-empty > svg { color: var(--accent); }.section-empty a { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); margin-left: auto; }.section-empty a:hover { color: var(--accent); }
.home-empty { margin: 45px auto 30px; min-height: 310px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 12px; background: #101016; text-align: center; padding: 30px; }.home-empty-icon { display: grid; place-items: center; width: 62px; height: 62px; color: var(--accent); border: 1px solid #a78bfa20; background: #a78bfa08; border-radius: 18px; }.home-empty h2 { font-size: 17px; font-weight: 500; margin: 23px 0 0; }.home-empty p { color: var(--text-faint); font-size: 13px; line-height: 1.8; margin: 11px 0 24px; }.home-empty .btn { min-height: 35px; }
.heading-skeleton { width: 100px; height: 19px; margin-bottom: 17px; }.landscape-skeleton { aspect-ratio: 16/9; }.poster-skeleton { aspect-ratio: 2/3; }.text-skeleton { width: 75%; height: 12px; margin-top: 12px; }
@media(min-width:1600px) { .recent-series-row { grid-auto-columns: calc((100% - 154px) / 12); } }
@media(max-width:1150px) { .recent-series-row { grid-auto-columns: calc((100% - 84px) / 7); }.history-row { grid-template-columns: minmax(0,1fr) 85px 120px 110px 25px; gap: 15px; }.history-thumb { width: 73px; }.history-source { font-size: 10px; } }
@media(max-width:900px) { .continue-row { grid-auto-columns: calc((100% - 32px) / 3); }.recent-series-row { grid-auto-columns: calc((100% - 70px) / 6); }.history-row { grid-template-columns: minmax(0,1fr) 115px 105px 25px; gap: 12px; }.history-source { display: none; }.source-grid { grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); }.source-card { padding: 13px; gap: 11px; }.source-copy strong { font-size: 13px; }.source-copy small { font-size: 10px; } }
@media(max-width:650px) { .home { padding-top: 20px; }.page-heading { margin-bottom: 18px; }.page-heading h1 { font-size: 21px; }.page-actions { gap: 6px; }.source-section { margin-bottom: 26px; }.source-grid { display: grid; grid-auto-flow: column; grid-template-columns: none; grid-auto-columns: minmax(190px,75%); overflow-x: auto; padding: 1px 1px 5px; gap: 10px; scrollbar-width: thin; }.source-card { min-height: 72px; }.source-icon { width: 34px; height: 34px; }.home-section { margin-bottom: 27px; }.section-heading { margin-bottom: 13px; }.section-heading h2 { font-size: 16px; }.section-link { font-size: 11px; }.continue-row { grid-auto-columns: 73%; gap: 12px; }.continue-meta strong { font-size: 14px; }.continue-episode { font-size: 12px; }.recent-series-row { grid-auto-columns: calc((100% - 30px) / 3.2); gap: 12px; }.series-card > strong { font-size: 12px; }.history-row { grid-template-columns: minmax(0,1fr) 24px; grid-template-rows: auto auto; gap: 4px 10px; min-height: 79px; padding: 12px 10px; }.history-main { grid-column: 1; grid-row: 1 / 3; gap: 10px; padding-right: 92px; }.history-thumb { width: 62px; }.history-copy strong { font-size: 12px; }.history-copy small { font-size: 10px; }.history-progress { grid-column: 1; grid-row: 1; justify-self: end; align-self: end; margin-right: 1px; max-width: 90px; font-size: 9px; pointer-events: none; }.history-time { grid-column: 1; grid-row: 2; justify-self: end; align-self: start; font-size: 9px; pointer-events: none; }.delete-record { grid-column: 2; grid-row: 1 / 3; opacity: .7; width: 24px; }.history-tabs { margin-bottom: 17px; gap: 22px; }.history-heading select { font-size: 11px; max-width: 150px; }.section-empty { padding: 19px 13px; font-size: 11px; gap: 8px; }.home-empty { margin-top: 25px; min-height: 280px; padding: 25px 18px; }.home-empty p { font-size: 12px; } }
@media(max-width:380px) { .history-main { padding-right: 77px; gap: 8px; }.history-thumb { width: 48px; }.history-progress { font-size: 8px; }.history-time { font-size: 8px; }.section-empty a { display: none; }.recent-series-row { grid-auto-columns: calc((100% - 20px) / 2.5); } }

/* 手柄选中态细节：在全局高亮环之外提亮卡片局部 */
.source-card[data-gp-focused] { border-color: #c4b5fd; background: #1a1624; }
.source-card[data-gp-focused] .source-copy strong { color: #f2ecff; }
.source-card[data-gp-focused] .source-icon { color: #d6c6ff; border-color: #a78bfa55; }
html.gp-mode .continue-card[data-gp-focused] .continue-cover { outline-color: #e2d7ff; }
.continue-card[data-gp-focused] .continue-meta strong { color: #f2ecff; }
html.gp-mode .series-card[data-gp-focused] .series-cover { outline-color: #e2d7ff; }
.series-card[data-gp-focused] > strong { color: #f2ecff; }
.series-card[data-gp-focused] .series-episode { color: #cdc5dc; }
.history-main[data-gp-focused] .history-copy strong { color: #f2ecff; }
</style>
