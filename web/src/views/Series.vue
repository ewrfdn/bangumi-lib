<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Poster from '../components/Poster.vue'
import Icon from '../components/Icon.vue'
import { api, fmtSize, mediaCoverUrl, mediaSourceLabel, mediaTypeLabel, parseEpisode } from '../api'

const props = defineProps({
  path: { type: String, default: '' },
  library: { type: String, default: '' },
})
const router = useRouter()
const loading = ref(true)
const error = ref('')
const detail = ref(null)
const tagsExpanded = ref(false)
let requestId = 0

watch(() => [props.path, props.library], load, { immediate: true })

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  tagsExpanded.value = false
  try {
    const data = await api.series(props.path, props.library)
    if (id === requestId) detail.value = data
  } catch (e) {
    if (id === requestId) { detail.value = null; error.value = e.message }
  } finally {
    if (id === requestId) loading.value = false
  }
}

const mediaById = computed(() => new Map((detail.value?.media || []).map((item) => [item.id, item])))
const groups = computed(() => {
  const map = new Map()
  for (const video of detail.value?.videos || []) {
    const key = video.mediaId ? `media:${video.mediaId}` : `season:${video.seasonPath}`
    let group = map.get(key)
    if (!group) {
      group = { key, mediaId: video.mediaId || null, media: mediaById.value.get(video.mediaId) || null, seasonName: video.seasonName, videos: [] }
      map.set(key, group)
    }
    group.videos.push(video)
  }
  const list = [...map.values()]
  for (const group of list) group.videos.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
  return list.sort((a, b) => {
    const sa = a.media?.season ?? 999
    const sb = b.media?.season ?? 999
    if (sa !== sb) return sa - sb
    return groupTitle(a).localeCompare(groupTitle(b), 'zh-CN', { numeric: true })
  })
})
const heroMedia = computed(() => groups.value[0]?.media || detail.value?.media?.[0] || null)
const title = computed(() => detail.value?.media?.length > 1 ? detail.value.name : heroMedia.value?.title || detail.value?.name || '')
const originalTitle = computed(() => heroMedia.value?.attribute?.metadata?.originalTitle || '')
const cover = computed(() => mediaCoverUrl(heroMedia.value?.cover, detail.value?.libraryId))
const type = computed(() => mediaTypeLabel(heroMedia.value?.mediaType))
const source = computed(() => mediaSourceLabel(heroMedia.value?.dataSource))
const totalVideos = computed(() => detail.value?.videos?.length || 0)
const firstVideo = computed(() => groups.value[0]?.videos?.[0] || null)
const hasTags = computed(() => Boolean(heroMedia.value?.tags?.length))
const visibleTags = computed(() => {
  const tags = heroMedia.value?.tags || []
  return tagsExpanded.value ? tags : tags.slice(0, 8)
})
const hasDescription = computed(() => Boolean(heroMedia.value?.description))
const displayPath = computed(() => {
  const value = detail.value?.path || ''
  try { return decodeURIComponent(value) } catch { return value }
})
const meta = computed(() => {
  const media = heroMedia.value
  const rows = []
  if (media?.airedOn) rows.push(['放送开始', media.airedOn])
  if (media?.series && media.series !== title.value) rows.push(['系列', media.series])
  if (detail.value?.libraryName) rows.push(['媒体库', detail.value.libraryName])
  rows.push(['本地目录', displayPath.value])
  return rows
})

function groupTitle(group) {
  if (!group.media) return group.seasonName || '全部剧集'
  const base = group.media.title
  if (!group.seasonName || group.seasonName === '全部剧集' || base.includes(group.seasonName)) return base
  return `${base} · ${group.seasonName}`
}
function episodeNumber(video, index) {
  const parsed = parseEpisode(video.name).episode
  const value = Number.isInteger(parsed) && parsed > 0 && parsed < 1000 ? parsed : index + 1
  return String(value).padStart(2, '0')
}
function episodeFile(video) {
  return video.size ? fmtSize(video.size) : video.name.replace(/\.[^.]+$/, '')
}
function play(video) {
  if (!video) return
  router.push({ name: 'watch', query: { path: video.path, library: detail.value?.libraryId || props.library } })
}
function sourceUrl() {
  const value = heroMedia.value?.dataSourceUrl
  if (!value) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
function browseTarget() {
  return { name: 'browse', query: { path: detail.value?.path || props.path, library: detail.value?.libraryId || props.library } }
}
function libraryTarget() {
  return { name: 'library', query: { library: detail.value?.libraryId || props.library } }
}
</script>

<template>
  <div class="series-page container">
    <div class="series-nav">
      <router-link :to="libraryTarget()" class="back"><Icon name="chevron-left" :size="15" />媒体库</router-link>
      <router-link :to="browseTarget()" class="nav-link"><Icon name="folder" :size="14" />文件浏览</router-link>
    </div>

    <div v-if="loading" class="series-loading" aria-busy="true">
      <div class="skeleton cover-skeleton" />
      <div class="loading-lines"><div class="skeleton title-skeleton" /><div class="skeleton line" /><div class="skeleton line short" /></div>
    </div>
    <div v-else-if="error" class="notice err" role="alert"><span>{{ error }}</span><router-link class="btn small ghost" :to="libraryTarget()">返回媒体库</router-link></div>
    <template v-else-if="detail">
      <section class="hero">
        <div class="hero-cover"><Poster :name="title" :src="cover" :poster="detail.poster || ''" :library="detail.libraryId" /></div>
        <div class="hero-body">
          <p class="eyebrow"><span>{{ detail.libraryName }}</span><span v-if="source" class="dot">·</span><span v-if="source">{{ source }}</span></p>
          <div class="title-row"><h1>{{ title }}</h1><span v-if="heroMedia?.rating" class="rating">★ {{ heroMedia.rating }}</span></div>
          <p v-if="originalTitle" class="original">{{ originalTitle }}</p>
          <div class="badges">
            <span v-if="type" class="chip">{{ type }}</span>
            <span v-if="heroMedia?.season" class="chip">第 {{ heroMedia.season }} 季</span>
            <span v-if="heroMedia?.episodeCount" class="chip">{{ heroMedia.episodeCount }} 集</span>
          </div>
          <p v-if="hasDescription" class="description">{{ heroMedia.description }}</p>
          <div v-if="hasTags" class="tags"><span v-for="tag in visibleTags" :key="tag" class="chip">{{ tag }}</span><button v-if="heroMedia.tags.length > 8" type="button" class="tag-toggle" @click="tagsExpanded = !tagsExpanded">{{ tagsExpanded ? '收起' : `+${heroMedia.tags.length - 8}` }}</button></div>
          <dl class="meta">
            <template v-for="[label, value] in meta" :key="label"><dt>{{ label }}</dt><dd :class="{ mono: label === '本地目录' }">{{ value }}</dd></template>
            <template v-if="sourceUrl()"><dt>来源</dt><dd><a :href="sourceUrl()" target="_blank" rel="noopener noreferrer">{{ source || '原始条目' }}<Icon name="arrow-up-right" :size="11" /></a></dd></template>
          </dl>
          <div class="actions">
            <button type="button" class="btn primary play-button" :disabled="!firstVideo" @click="play(firstVideo)"><Icon name="play" :size="16" />{{ firstVideo ? '播放' : '暂无可播放视频' }}</button>
            <a v-if="totalVideos" class="btn" href="#episodes">选集</a>
          </div>
        </div>
      </section>

      <section id="episodes" class="episodes">
        <div class="episodes-heading">
          <div><h2>剧集选择</h2><p v-if="totalVideos">共 {{ totalVideos }} 集，点击集数开始播放</p><p v-else>这个目录里还没有识别到视频文件</p></div>
          <span v-if="totalVideos" class="episode-count">{{ totalVideos }}</span>
        </div>
        <div v-if="!groups.length" class="empty"><div class="empty-icon"><Icon name="film" :size="26" /></div><h3>还没有剧集</h3><p class="muted">把视频放进这个目录后，在媒体库页刷新即可。</p><router-link class="btn small" :to="browseTarget()">打开文件浏览</router-link></div>
        <div v-for="group in groups" :key="group.key" class="group">
          <div v-if="groups.length > 1" class="group-heading"><h3>{{ groupTitle(group) }}</h3><span>{{ group.videos.length }} 集</span></div>
          <div class="episode-grid">
            <button v-for="(video, index) in group.videos" :key="video.path" type="button" class="episode" :title="video.name" @click="play(video)">
              <span class="episode-no">{{ episodeNumber(video, index) }}</span>
              <span class="episode-name">{{ episodeFile(video) }}</span>
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.series-page { padding: 22px 0 56px; max-width: 1100px; }
.series-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.back, .nav-link { display: inline-flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 12px; }
.back:hover, .nav-link:hover { color: var(--accent); }
.hero { display: grid; grid-template-columns: 248px minmax(0, 1fr); gap: 30px; align-items: start; }
.hero-cover { width: 100%; overflow: hidden; border: 1px solid var(--line-strong); border-radius: 8px; background: #16131f; box-shadow: 0 20px 44px -28px #000; }
.eyebrow { margin: 0 0 9px; color: var(--text-faint); font-size: 11px; letter-spacing: .04em; }
.eyebrow .dot { margin: 0 6px; }
.title-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.title-row h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -.6px; line-height: 1.35; }
.rating { color: #e3c49c; font-size: 13px; white-space: nowrap; }
.original { margin: 7px 0 0; color: var(--text-faint); font-size: 12px; }
.badges, .tags { display: flex; flex-wrap: wrap; gap: 7px; }
.badges { margin-top: 14px; }
.description { margin: 16px 0 0; max-width: 720px; color: var(--text-dim); font-size: 12px; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; }
.tags { margin-top: 14px; }
.tag-toggle { padding: 3px 8px; border: 1px dashed var(--line-strong); border-radius: 999px; background: transparent; color: var(--text-faint); font-size: 10px; }
.tag-toggle:hover { color: var(--accent); border-color: #a78bfa55; }
.meta { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 9px 14px; margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; }
.meta dt { color: var(--text-faint); }
.meta dd { margin: 0; color: var(--text-dim); overflow-wrap: anywhere; }
.meta a { display: inline-flex; align-items: center; gap: 4px; color: #c5b2fa; }
.actions { display: flex; gap: 9px; margin-top: 22px; flex-wrap: wrap; }
.play-button { padding-left: 18px; padding-right: 20px; }
.episodes { margin-top: 38px; padding-top: 24px; border-top: 1px solid var(--line); }
.episodes-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.episodes-heading h2 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.3px; }
.episodes-heading p { margin: 7px 0 0; color: var(--text-faint); font-size: 11px; }
.episode-count { display: grid; place-items: center; min-width: 28px; height: 22px; padding: 0 7px; border: 1px solid #a78bfa25; border-radius: 11px; background: #a78bfa12; color: #c8b3ff; font-size: 11px; }
.group + .group { margin-top: 24px; }
.group-heading { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.group-heading h3 { margin: 0; color: var(--text); font-size: 13px; font-weight: 500; }
.group-heading span { color: var(--text-faint); font-size: 10px; }
.episode-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
.episode { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-height: 62px; padding: 9px 11px; border: 1px solid var(--line-strong); border-radius: 7px; background: #101016; text-align: left; transition: border-color .15s, background .15s; }
.episode:hover { border-color: #a78bfa66; background: #a78bfa0a; }
.episode-no { color: #d8c8ff; font-size: 20px; font-weight: 500; line-height: 1.1; font-variant-numeric: tabular-nums; }
.episode-name { width: 100%; color: var(--text-faint); font-size: 9px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.series-loading { display: grid; grid-template-columns: 248px 1fr; gap: 30px; }
.cover-skeleton { aspect-ratio: 2 / 3; border-radius: 8px; }
.loading-lines { padding-top: 12px; }
.title-skeleton { width: 45%; height: 26px; margin-bottom: 18px; }
.loading-lines .line { width: 80%; height: 12px; margin-bottom: 10px; }
.loading-lines .line.short { width: 55%; }
@media(max-width:800px) { .hero { grid-template-columns: 190px minmax(0, 1fr); gap: 22px; }.series-loading { grid-template-columns: 190px 1fr; }.title-row h1 { font-size: 22px; } }
@media(max-width:640px) { .series-page { padding-top: 16px; }.hero { grid-template-columns: 1fr; gap: 18px; }.hero-cover { width: 132px; }.series-loading { grid-template-columns: 1fr; }.cover-skeleton { width: 132px; }.title-row h1 { font-size: 21px; }.episode-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }.episode { min-height: 58px; padding: 8px 10px; }.episode-no { font-size: 18px; }.meta { grid-template-columns: 58px minmax(0, 1fr); } }
</style>
