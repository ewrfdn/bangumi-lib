<script setup>
/**
 * 手柄 HUD：屏幕底部的按键提示条 + 顶部居中连接 / 断开提示。
 *
 * - 提示条只在「手柄模式」且偏好允许、没有浮层时出现；
 * - 整个组件 pointer-events: none，没有可聚焦元素，不参与 Tab / 空间导航；
 * - 提示内容来自 store 的 gamepad.hints（由页面上下文与 dispatch 维护），
 *   按键符号按 HINT_ORDER 顺序从当前映射换算；
 * - toast 完全跟随 store 的 gamepad.toast 生命周期，组件不自行清除状态。
 */
import { computed } from 'vue'
import { BUTTON_LABELS, DIRECTION_ACTIONS, HINT_ORDER } from './constants.js'
import { gamepad } from './store.js'

const DIRECTION_ARROWS = Object.freeze({ up: '↑', down: '↓', left: '←', right: '→' })

/** 动作 → 提示条上的按键符号；方向动作固定显示方向箭头 */
function symbolFor(action) {
  if (DIRECTION_ACTIONS.includes(action)) return DIRECTION_ARROWS[action] || ''
  const button = Number(gamepad.prefs?.map?.[action])
  if (!Number.isInteger(button) || button < 0 || button >= BUTTON_LABELS.length) return ''
  return BUTTON_LABELS[button] || ''
}

const hintItems = computed(() => {
  const hints = gamepad.hints || {}
  const items = []
  for (const action of HINT_ORDER) {
    const text = hints[action]
    if (!text) continue
    const key = symbolFor(action)
    if (!key) continue
    items.push({ action, key, text: String(text) })
  }
  return items
})

const showHints = computed(() => Boolean(
  gamepad.mode
  && gamepad.prefs?.hintBar
  && !gamepad.overlay
  && hintItems.value.length,
))

const toast = computed(() => gamepad.toast)
</script>

<template>
  <div class="gp-hud" data-gp-skip>
    <!-- 连接 / 断开提示：常驻 aria-live 区域，内容跟随 store 自动消失 -->
    <div class="gp-toast-region" role="status" aria-live="polite">
      <Transition name="gp-toast">
        <div v-if="toast" :key="toast.at || toast.text" class="gp-toast">
          <span class="gp-toast-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c0 .05-.01.1-.02.15C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.68-7.26l-.02-.15A4 4 0 0 0 17.32 5Z" />
              <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
            </svg>
          </span>
          <span class="gp-toast-copy">
            <strong>{{ toast.text }}</strong>
            <span v-if="toast.sub">{{ toast.sub }}</span>
          </span>
        </div>
      </Transition>
    </div>

    <!-- 底部按键提示条：仅手柄模式下显示，纯展示、不可交互 -->
    <Transition name="gp-hint">
      <div v-if="showHints" class="gp-hintbar" aria-hidden="true">
        <span class="gp-hint-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c0 .05-.01.1-.02.15C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.68-7.26l-.02-.15A4 4 0 0 0 17.32 5Z" />
            <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
          </svg>
        </span>
        <span v-for="item in hintItems" :key="item.action" class="gp-hint">
          <kbd class="gp-key">{{ item.key }}</kbd>
          <span class="gp-hint-text">{{ item.text }}</span>
        </span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gp-hud {
  position: fixed;
  inset: 0;
  z-index: 80;
  pointer-events: none;
  font-family: inherit;
}

.gp-toast-region {
  position: fixed;
  top: calc(14px + env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  justify-content: center;
  width: min(460px, calc(100vw - 28px));
  pointer-events: none;
}

.gp-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 9px 14px;
  border: 1px solid #a78bfa38;
  border-radius: 9px;
  background: #17171eee;
  box-shadow: 0 12px 35px #0008;
  backdrop-filter: blur(12px);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

.gp-toast-icon {
  display: inline-flex;
  flex: none;
  color: var(--accent);
}

.gp-toast-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.gp-toast-copy strong {
  font-size: 12px;
  font-weight: 500;
}

.gp-toast-copy span {
  color: var(--text-dim);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.gp-hintbar {
  position: fixed;
  left: 50%;
  bottom: calc(12px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 7px 14px;
  max-width: calc(100vw - 24px);
  padding: 8px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: #121218e6;
  box-shadow: 0 10px 30px #0007;
  backdrop-filter: blur(10px);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.4;
  pointer-events: none;
}

.gp-hint-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-right: 2px;
  color: var(--accent);
  opacity: .85;
}

.gp-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.gp-key {
  display: inline-flex;
  min-width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border: 1px solid #ffffff22;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #ffffff0a;
  color: #ddd9ea;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  line-height: 1;
}

.gp-hint-text {
  color: var(--text-dim);
}

.gp-hint-enter-active,
.gp-hint-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}

.gp-hint-enter-from,
.gp-hint-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}

.gp-toast-enter-active,
.gp-toast-leave-active {
  transition: opacity .2s ease, transform .2s ease;
}

.gp-toast-enter-from,
.gp-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 520px) {
  .gp-hintbar {
    gap: 6px 11px;
    padding: 7px 11px;
    font-size: 10px;
  }

  .gp-key {
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    font-size: 9px;
  }
}
</style>
