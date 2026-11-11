import { reactive } from 'vue'
import { DEFAULT_HINTS, STORAGE_KEY, normalizePrefs } from './constants.js'

const hasWindow = typeof window !== 'undefined'
const hasNavigator = typeof navigator !== 'undefined'

/**
 * 全局手柄状态单例。
 * - mode：手柄模式（高亮 + 提示条），检测到手柄且启用时打开
 * - pointer：最近一次输入是否来自鼠标；手柄输入会切回 false
 * - overlay：当前浮层（全局只允许一层），null 表示无浮层
 * - live：设置页按键测试用的实时快照
 */
export const gamepad = reactive({
  supported: hasNavigator && typeof navigator.getGamepads === 'function',
  secure: !hasWindow || window.isSecureContext !== false,
  connected: false,
  devices: [],
  activeIndex: -1,
  id: '',
  mapping: '',
  mode: false,
  pointer: true,
  prefs: normalizePrefs(null),
  overlay: null,
  live: { buttons: [], axes: [], id: '' },
  toast: null,
  hints: { ...DEFAULT_HINTS },
})

let previousFocus = null
let toastTimer = null

export function loadPrefs() {
  if (!hasWindow) return gamepad.prefs
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return gamepad.prefs
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    // 损坏或缺字段的数据回退默认值，避免坏偏好影响轮询
    gamepad.prefs = normalizePrefs(parsed)
  } catch { /* 隐私模式 / localStorage 不可用 */ }
  return gamepad.prefs
}

function persistPrefs() {
  if (!hasWindow) return
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(gamepad.prefs)) } catch { /* 隐私模式忽略 */ }
}

export function savePrefs(patch = {}) {
  const next = { ...gamepad.prefs, ...patch }
  if (patch.map) next.map = { ...gamepad.prefs.map, ...patch.map }
  gamepad.prefs = normalizePrefs(next)
  persistPrefs()
  return gamepad.prefs
}

export function resetPrefs() {
  gamepad.prefs = normalizePrefs(null)
  persistPrefs()
  return gamepad.prefs
}

export function setPointer(active) {
  const next = Boolean(active)
  if (gamepad.pointer !== next) gamepad.pointer = next
}

export function setDevices(devices) {
  gamepad.devices = devices
  if (!devices.length) {
    gamepad.connected = false
    gamepad.activeIndex = -1
    gamepad.id = ''
    gamepad.mapping = ''
    gamepad.mode = false
    gamepad.live = { buttons: [], axes: [], id: '' }
  }
}

export function setActivePad(pad) {
  if (!pad) return
  gamepad.connected = true
  gamepad.activeIndex = pad.index
  gamepad.id = pad.id || ''
  gamepad.mapping = pad.mapping || ''
  if (gamepad.prefs.enabled) gamepad.mode = true
}

export function setLive(buttons, axes, id) {
  gamepad.live = { buttons, axes, id }
}

export function showToast(text, sub = '', duration = 4000) {
  clearTimeout(toastTimer)
  gamepad.toast = { text, sub, at: Date.now() }
  toastTimer = setTimeout(() => { gamepad.toast = null }, duration)
}

export function openOverlay(payload) {
  if (!payload || !hasWindow) return
  if (!gamepad.overlay) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  gamepad.overlay = payload
}

/** 关闭浮层并返回打开前的焦点元素，由调用方在 DOM 更新后恢复焦点 */
export function closeOverlay() {
  gamepad.overlay = null
  const restore = previousFocus
  previousFocus = null
  return restore
}

export function overlayPreviousFocus() {
  return previousFocus
}
