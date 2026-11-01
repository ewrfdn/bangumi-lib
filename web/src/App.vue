<script setup>
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'

const route = useRoute()
const status = ref(null)
const showStatus = ref(false)

onMounted(async () => {
  try {
    status.value = await api.status()
  } catch {}
})

const isPlayer = () => route.name === 'watch'
</script>

<template>
  <div class="app" :class="{ 'is-player': isPlayer() }">
    <header v-if="!isPlayer()" class="topbar">
      <div class="container topbar-inner">
        <router-link to="/" class="brand">
          <span class="logo">
            <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
              <path d="M5 7h22a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" />
              <path d="M13 12l8 4.5-8 4.5z" fill="currentColor" />
            </svg>
          </span>
          <span class="brand-text">Ani<span>Share</span></span>
        </router-link>

        <nav class="nav">
          <router-link to="/" class="nav-link" exact-active-class="active">番剧库</router-link>
          <router-link to="/browse" class="nav-link" active-class="active">浏览文件</router-link>
        </nav>

        <div class="spacer" />

        <button class="status-pill" :class="{ ok: status?.ffmpeg, bad: status && !status.ffmpeg }" title="服务状态" @click="showStatus = !showStatus">
          <span class="dot" />
          <span class="pill-label">{{ status ? (status.ffmpeg ? '转码就绪' : '无 ffmpeg') : '连接中' }}</span>
        </button>

        <transition name="fade">
          <div v-if="showStatus && status" class="status-card" @click.self="showStatus = false">
            <div class="status-head">
              <strong>服务状态</strong>
              <button class="btn small ghost" @click="showStatus = false">关闭</button>
            </div>
            <dl>
              <dt>媒体目录</dt><dd class="mono">{{ status.root }}</dd>
              <dt>目录存在</dt><dd>{{ status.rootExists ? '是' : '否（请检查 BANGUMI_ROOT）' }}</dd>
              <dt>ffmpeg</dt><dd class="mono">{{ status.ffmpeg || '未找到' }}</dd>
              <dt>ffprobe</dt><dd class="mono">{{ status.ffprobe || '未找到' }}</dd>
              <dt>转码编码器</dt>
              <dd><span class="chip" :class="status.transcode ? 'ok' : 'err'">{{ status.transcode?.encoder || '不可用' }}</span></dd>
              <dt>硬件加速</dt><dd class="mono">{{ (status.hwaccels || []).join(', ') || '—' }}</dd>
            </dl>
          </div>
        </transition>
      </div>
    </header>

    <main class="main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" :key="route.fullPath" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-h);
  background: rgba(11, 13, 18, 0.72);
  backdrop-filter: saturate(160%) blur(18px);
  -webkit-backdrop-filter: saturate(160%) blur(18px);
  border-bottom: 1px solid var(--line);
}
.topbar-inner {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 28px;
  position: relative;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 0.2px;
}
.logo {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--grad);
  color: #fff;
  box-shadow: 0 6px 20px -8px rgba(124, 92, 255, 0.9);
}
.brand-text span {
  background: var(--grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.nav {
  display: flex;
  gap: 4px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--line);
  padding: 4px;
  border-radius: 999px;
}
.nav-link {
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--text-dim);
  transition: all 0.18s ease;
}
.nav-link:hover {
  color: var(--text);
}
.nav-link.active {
  background: var(--bg-elev-2);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.spacer {
  flex: 1;
}
.status-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 0 3px rgba(255, 176, 32, 0.15);
}
.status-pill.ok .dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(56, 214, 160, 0.15);
}
.status-pill.bad .dot {
  background: var(--err);
  box-shadow: 0 0 0 3px rgba(255, 92, 108, 0.15);
}
.status-card {
  position: absolute;
  right: 0;
  top: calc(100% + 10px);
  width: min(560px, 92vw);
  padding: 18px 20px;
  background: rgba(23, 27, 38, 0.96);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  backdrop-filter: blur(20px);
}
.status-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.status-card dl {
  margin: 0;
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 8px 12px;
  font-size: 13px;
}
.status-card dt {
  color: var(--text-faint);
}
.status-card dd {
  margin: 0;
  word-break: break-all;
}
.main {
  flex: 1;
  min-height: 0;
}
.is-player .main {
  min-height: 100vh;
}
@media (max-width: 640px) {
  .pill-label {
    display: none;
  }
  .nav-link {
    padding: 6px 12px;
  }
  .brand-text {
    display: none;
  }
}
</style>
