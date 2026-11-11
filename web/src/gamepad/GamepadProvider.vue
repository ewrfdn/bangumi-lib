<script setup>
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import GamepadHUD from './GamepadHUD.vue'
import GamepadKeyboard from './GamepadKeyboard.vue'
import GamepadSettings from './GamepadSettings.vue'
import { focusOverlay, installGamepad, refreshHints, shouldSuppressAutoFocus } from './dispatch.js'
import { focusDefault, focused } from './nav.js'
import { gamepad, loadPrefs } from './store.js'

const router = useRouter()
let dispose = null

function syncModeClass(mode) {
  document.documentElement.classList.toggle('gp-mode', Boolean(mode))
}
function syncCursorClass() {
  const hidden = Boolean(gamepad.mode && gamepad.prefs.hideCursor && !gamepad.pointer)
  document.documentElement.classList.toggle('gp-hide-cursor', hidden)
}

watch(() => gamepad.mode, async (mode) => {
  syncModeClass(mode)
  if (!mode) return
  // 手柄接入后立刻给默认落点高亮（播放器等媒体控制页面除外）
  await nextTick()
  if (!gamepad.mode || gamepad.overlay || shouldSuppressAutoFocus() || focused()) return
  focusDefault()
}, { immediate: true })
watch(() => [gamepad.mode, gamepad.prefs.hideCursor, gamepad.pointer], syncCursorClass, { immediate: true })
watch(() => gamepad.overlay?.kind, async (kind) => {
  refreshHints()
  if (!kind) return
  await nextTick()
  if (gamepad.overlay?.kind !== kind) return
  focusOverlay()
})

onMounted(() => {
  loadPrefs()
  syncModeClass(gamepad.mode)
  syncCursorClass()
  dispose = installGamepad({ router })
})
onBeforeUnmount(() => {
  dispose?.()
  dispose = null
  document.documentElement.classList.remove('gp-mode', 'gp-hide-cursor')
})
</script>

<template>
  <GamepadHUD />
  <GamepadSettings v-if="gamepad.overlay?.kind === 'settings'" />
  <GamepadKeyboard v-if="gamepad.overlay?.kind === 'keyboard'" />
</template>
