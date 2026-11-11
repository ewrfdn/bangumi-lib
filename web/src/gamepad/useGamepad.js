import { computed, onBeforeUnmount, onMounted, unref, watch } from 'vue'
import { ACTION } from './constants.js'
import { closeCurrentOverlay, registerGamepadContext } from './dispatch.js'
import { cancelButtonCapture, captureNextButton } from './engine.js'
import { gamepad, loadPrefs, openOverlay, resetPrefs, savePrefs } from './store.js'

/** 组件里访问手柄状态与全局操作 */
export function useGamepad() {
  return {
    gamepad,
    action: ACTION,
    prefs: computed(() => gamepad.prefs),
    supported: computed(() => gamepad.supported),
    secure: computed(() => gamepad.secure),
    connected: computed(() => gamepad.connected),
    mode: computed(() => gamepad.mode),
    overlay: computed(() => gamepad.overlay),
    openOverlay,
    closeOverlay: closeCurrentOverlay,
    loadPrefs,
    savePrefs,
    resetPrefs,
    captureNextButton,
    cancelButtonCapture,
  }
}

/**
 * 在当前组件生命周期内注册手柄上下文。
 * handle(action, meta) 返回 true 表示消费该动作，默认导航不再执行。
 * hints 用于底部提示条，键名使用 ACTION 常量。
 *
 * @param {{ id?: string, hints?: Record<string,string>, handle?: Function, overlay?: boolean, keepFocusless?: boolean, enabled?: boolean|import('vue').Ref<boolean> }} options
 * overlay=true 表示这是浮层内组件的上下文，只在有浮层时生效。
 * keepFocusless=true 表示页面坚持无焦点（如播放器媒体控制），手柄连接时不自动聚焦。
 */
export function useGamepadContext({ id, hints, handle, overlay = false, keepFocusless = false, enabled = true } = {}) {
  let unregister = null
  const active = computed(() => unref(enabled) !== false)

  const sync = () => {
    unregister?.()
    unregister = null
    if (active.value) unregister = registerGamepadContext({ id, hints, handle, overlay, keepFocusless })
  }

  onMounted(sync)
  watch(active, sync)
  onBeforeUnmount(() => {
    unregister?.()
    unregister = null
  })

  return { refresh: sync }
}
