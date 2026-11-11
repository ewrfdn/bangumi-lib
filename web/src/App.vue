<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'
import { auth, logout } from './auth'
import AgentChat from './components/AgentChat.vue'
import Icon from './components/Icon.vue'
import GamepadProvider from './gamepad/GamepadProvider.vue'
import { useGamepad } from './gamepad/useGamepad.js'

const route = useRoute()
const router = useRouter()
const { gamepad, openOverlay } = useGamepad()
const status = ref(null)
const statusBusy = ref(false)
const showStatus = ref(false)
const loggingOut = ref(false)
const logoutError = ref('')
const hasShell = computed(() => Boolean(route.name) && auth.checked && !['watch', 'login'].includes(route.name))
const libraryQuery = computed(() => route.query.library ? { library: route.query.library } : {})
const statusSources = computed(() => status.value?.libraries || [])

watch(() => [route.name, auth.authenticated, auth.checked], async () => {
  showStatus.value = false
  if (!hasShell.value || (auth.enabled && !auth.authenticated) || status.value || statusBusy.value) return
  await loadStatus()
}, { immediate: true })
async function loadStatus() {
  statusBusy.value = true
  try { status.value = await api.status() } catch {}
  finally { statusBusy.value = false }
}
async function exit() {
  loggingOut.value = true
  logoutError.value = ''
  try { await logout(); status.value = null; await router.replace('/login') }
  catch (e) { logoutError.value = e.message }
  finally { loggingOut.value = false }
}
</script>

<template>
  <div class="app">
    <a v-if="hasShell" class="skip-link" href="#main-content">跳到内容</a>
    <header v-if="hasShell" class="topbar">
      <div class="container topbar-inner">
        <router-link to="/" class="brand" aria-label="AniShare 首页"><span class="logo"><Icon name="play" :size="16" /></span>AniShare</router-link>
        <nav class="nav" aria-label="主导航">
          <router-link :to="{ name: 'home' }" :class="{ active: route.name === 'home' }">首页</router-link>
          <router-link :to="{ name: 'library', query: libraryQuery }" :class="{ active: route.name === 'library' }">媒体库</router-link>
          <router-link class="file-nav" :to="{ name: 'browse', query: libraryQuery }" :class="{ active: route.name === 'browse' }">文件浏览</router-link>
          <router-link :to="{ name: 'admin' }" :class="{ active: route.name === 'admin' }">后台管理</router-link>
        </nav>
        <div class="topbar-end"><span v-if="auth.enabled" class="auth-label"><Icon name="shield" :size="13" />密钥访问</span><button class="icon-button gamepad-button" :class="{ connected: gamepad.connected }" title="手柄设置" aria-label="手柄设置" @click="openOverlay({ kind: 'settings' })"><Icon name="gamepad" :size="18" /></button><button class="icon-button service-button" :aria-expanded="showStatus" aria-controls="service-status" @click="showStatus = !showStatus" title="服务状态" aria-label="服务状态"><Icon name="settings" :size="18" /></button><button v-if="auth.enabled && auth.authenticated" class="icon-button" title="退出登录" aria-label="退出登录" :disabled="loggingOut" @click="exit"><Icon name="logout" :size="18" /></button></div>
        <div v-if="showStatus" id="service-status" class="status-card">
          <div class="status-head"><strong>服务状态</strong><button class="icon-button" aria-label="关闭服务状态" @click="showStatus = false"><Icon name="close" :size="16" /></button></div>
          <dl v-if="status">
            <template v-if="statusSources.length"><template v-for="source in statusSources" :key="source.id"><dt>{{ source.name }}</dt><dd><span>{{ source.available === false ? '未连接' : '已连接' }}</span><code v-if="source.root">{{ source.root }}</code></dd></template></template>
            <template v-else><dt>媒体目录</dt><dd><span>{{ status.rootExists ? '已连接' : '未找到目录' }}</span><code>{{ status.root }}</code></dd></template>
            <dt>视频转码</dt><dd>{{ status.transcode?.encoder || (status.ffmpeg ? '已就绪' : '未找到 ffmpeg') }}</dd>
            <dt v-if="status.database">观看记录</dt><dd v-if="status.database">SQLite</dd>
            <dt>访问方式</dt><dd>{{ auth.enabled ? '密钥登录' : '直接访问' }}</dd>
          </dl>
          <div v-else class="status-empty"><p>{{ statusBusy ? '正在连接服务…' : '暂时无法连接服务' }}</p><button v-if="!statusBusy" class="btn small" @click="loadStatus">重试</button></div>
        </div>
      </div>
    </header>
    <div v-if="logoutError" class="container notice err" role="alert">{{ logoutError }}</div>
    <main id="main-content"><router-view v-slot="{ Component }"><component :is="Component" :key="route.path + JSON.stringify(route.query)" /></router-view></main>
    <GamepadProvider />
    <AgentChat v-if="hasShell" />
  </div>
</template>

<style scoped>
.app { min-height: 100vh; }.skip-link { position: fixed; top: -100px; left: 15px; z-index: 100; padding: 11px 16px; border-radius: 6px; color: #fff; background: #9c7cf4; font-size: 13px; }.skip-link:focus { top: 10px; }
.topbar { height: 62px; border-bottom: 1px solid var(--line); background: #0e0e15ed; position: sticky; top: 0; z-index: 40; backdrop-filter: blur(16px); }
.topbar-inner { position: relative; height: 100%; display: flex; align-items: center; gap: 47px; }.brand { display: flex; align-items: center; gap: 9px; font-size: 18px; font-weight: 650; letter-spacing: -.5px; }.logo { width: 28px; height: 28px; color: #d6c6ff; background: #a78bfa17; border: 1px solid #a78bfa30; border-radius: 8px; display: grid; place-items: center; }.nav { display: flex; gap: 29px; height: 100%; }.nav a { position: relative; display: flex; align-items: center; font-size: 13px; color: var(--text-faint); white-space: nowrap; }.nav a:hover { color: var(--text); }.nav a.active { color: #ccb8ff; }.nav a.active::after { content: ''; height: 2px; background: var(--accent); position: absolute; bottom: 0; left: 0; right: 0; }
.topbar-end { display: flex; align-items: center; gap: 10px; margin-left: auto; }.auth-label { display: inline-flex; align-items: center; gap: 5px; color: var(--text-faint); font-size: 11px; margin-right: 9px; }.auth-label svg { color: #b3a3ca; }.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 31px; height: 31px; padding: 0; border-radius: 6px; color: var(--text-faint); }.icon-button:hover { background: var(--bg-elev-2); color: var(--text); }.icon-button:disabled { opacity: .4; }.gamepad-button { position: relative; }.gamepad-button.connected { color: #c9b7fb; }.gamepad-button.connected::after { content: ''; position: absolute; top: 4px; right: 4px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px #a78bfa; }
.status-card { position: absolute; top: calc(100% + 8px); right: 0; width: min(430px, calc(100vw - 20px)); padding: 19px; background: #17171f; border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: var(--shadow); }.status-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }.status-head strong { font-size: 14px; font-weight: 500; }.status-card dl { margin: 0; display: grid; grid-template-columns: 78px 1fr; gap: 14px 16px; font-size: 12px; line-height: 1.6; }.status-card dt { color: var(--text-faint); overflow-wrap: anywhere; }.status-card dd { margin: 0; overflow-wrap: anywhere; }.status-card code { display: block; color: var(--text-faint); font: 10px/1.7 ui-monospace,monospace; margin-top: 4px; }.status-empty { font-size: 12px; color: var(--text-faint); }
@media(max-width:700px) { .topbar-inner { gap: 30px; }.nav { gap: 23px; }.auth-label { display: none; } }
@media(max-width:450px) { .nav .file-nav { display: none; }.topbar { height: 56px; }.topbar-inner { gap: 21px; }.brand { font-size: 16px; gap: 7px; }.logo { width: 24px; height: 24px; border-radius: 6px; }.nav { gap: 17px; }.nav a { font-size: 12px; }.topbar-end { gap: 3px; }.icon-button { width: 26px; height: 28px; } }
@media(max-width:380px) { .topbar-inner { gap: 17px; }.brand { font-size: 15px; }.logo { display: none; }.nav { gap: 15px; }.nav .file-nav { display: none; } }
</style>
