/**
 * 手柄输入引擎：轮询 Gamepad API，把物理按键/摇杆翻译成逻辑动作。
 *
 * - 第一次按下立即触发，长按方向键按偏好连发
 * - 支持改键捕获（captureNextButton）与调试注入（injectAction），便于无实体手柄时验证
 * - 连接 / 断开更新 store，并驱动「手柄模式」
 */
import { ACTION, BUTTON } from './constants.js'
import { gamepad, setActivePad, setDevices, setLive, setPointer, showToast } from './store.js'
import { createRepeatTracker, stickDirection } from './spatial.js'

const DIRECTION_BUTTONS = [
  [BUTTON.UP, ACTION.UP],
  [BUTTON.DOWN, ACTION.DOWN],
  [BUTTON.LEFT, ACTION.LEFT],
  [BUTTON.RIGHT, ACTION.RIGHT],
]
const NON_DIRECTION_ACTIONS = [ACTION.CONFIRM, ACTION.BACK, ACTION.CONTEXT, ACTION.MENU, ACTION.SEARCH, ACTION.PREV_TAB, ACTION.NEXT_TAB, ACTION.SETTINGS, ACTION.FULLSCREEN]

let handler = null
let running = false
let frameId = 0
let repeatTracker = createRepeatTracker()
let previousPressed = new Set()
let previousButtons = []
let captured = null
let captureTimer = null
let lastStickDirection = null
let liveStamp = 0
let seenPads = new Set()
let lastDevicesSignature = ''
const injected = new Set()
const injectedTaps = new Set()

function getPads() {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return []
  try {
    return Array.from(navigator.getGamepads() || []).filter(Boolean)
  } catch {
    return []
  }
}

function buttonPressed(button) {
  if (!button) return false
  if (typeof button === 'number') return button > 0.5
  return Boolean(button.pressed) || Number(button.value) > 0.5
}

function activePad(pads) {
  if (!pads.length) return null
  const current = pads.find((pad) => pad.index === gamepad.activeIndex)
  return current || pads[0]
}

function toastForPad(pad) {
  const key = `${pad.index}:${pad.id}`
  if (seenPads.has(key)) return
  seenPads.add(key)
  showToast('手柄已连接', pad.id || '标准手柄')
}

function syncConnection(pads) {
  const devices = pads.map((pad) => ({ index: pad.index, id: pad.id || '', mapping: pad.mapping || '', connected: true }))
  const signature = devices.map((pad) => `${pad.index}:${pad.id}:${pad.mapping}`).join('|')
  if (signature !== lastDevicesSignature) {
    lastDevicesSignature = signature
    setDevices(devices)
  }
  const alive = new Set(pads.map((pad) => pad.index))
  for (const key of [...seenPads]) {
    if (!alive.has(Number(key.split(':')[0]))) seenPads.delete(key)
  }
  const pad = activePad(pads)
  if (pad) {
    setActivePad(pad)
    toastForPad(pad)
  }
  const wanted = Boolean(pad && gamepad.prefs.enabled)
  if (gamepad.mode !== wanted) gamepad.mode = wanted
  return pad
}

function readPad(pad) {
  return {
    buttons: pad?.buttons ? Array.from(pad.buttons, (button) => buttonPressed(button)) : [],
    axes: pad?.axes ? Array.from(pad.axes, (axis) => Number(axis) || 0) : [],
    id: pad?.id || '',
  }
}

function rumble(pad) {
  if (!pad || !gamepad.prefs.vibration) return
  try {
    pad.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: 45, weakMagnitude: 0.35, strongMagnitude: 0.25 })
  } catch { /* 不支持震动时忽略 */ }
}

/** 物理按键 / 摇杆 → 当前帧按下的逻辑动作集合 */
function collectPressed(buttons, axes) {
  const pressed = new Set()
  let dpad = false

  for (const [index, action] of DIRECTION_BUTTONS) {
    if (buttons[index]) {
      dpad = true
      pressed.add(action)
    }
  }
  if (dpad) {
    lastStickDirection = null
  } else {
    const stick = stickDirection(axes, gamepad.prefs, lastStickDirection)
    if (stick) {
      pressed.add(stick)
      lastStickDirection = stick
    } else {
      lastStickDirection = null
    }
  }

  for (const action of NON_DIRECTION_ACTIONS) {
    const button = Number(gamepad.prefs.map?.[action])
    if (Number.isInteger(button) && button >= 0 && buttons[button]) pressed.add(action)
  }

  for (const action of injected) pressed.add(action)
  for (const action of injectedTaps) pressed.add(action)

  return pressed
}

function resetInputState() {
  previousPressed = new Set()
  previousButtons = []
  repeatTracker.reset()
  lastStickDirection = null
}

/** 捕获模式下：等待任意新按下的物理按键；期间不派发其他动作 */
function pollCapture(buttons) {
  if (!captured) return
  for (let index = 0; index < buttons.length; index++) {
    if (!buttons[index] || previousButtons[index]) continue
    const { callback } = captured
    captured = null
    clearTimeout(captureTimer)
    captureTimer = null
    previousButtons = buttons
    repeatTracker.reset()
    previousPressed = new Set()
    callback?.(index)
    return
  }
  previousButtons = buttons
  repeatTracker.reset()
  previousPressed = new Set()
}

function updateLive(buttons, axes, id, now) {
  if (gamepad.overlay?.kind !== 'settings') return
  if (now - liveStamp < 100) return
  liveStamp = now
  setLive(buttons.slice(0, 18), axes.slice(0, 4), id)
}

function emit(action, { repeat = false, source = 'button', pad = null } = {}) {
  setPointer(false)
  if (!repeat) rumble(pad)
  try {
    handler?.(action, { repeat, source, at: Date.now() })
  } catch (error) {
    console.error('[gamepad] action handler failed:', action, error)
  }
}

function processFrame(now, snapshot) {
  const { buttons, axes, id, pad } = snapshot
  const prefs = gamepad.prefs

  if (captured) {
    pollCapture(buttons)
    updateLive(buttons, axes, id, now)
    return
  }

  if (!prefs.enabled) {
    repeatTracker.reset()
    previousPressed = new Set()
    previousButtons = buttons
    injectedTaps.clear()
    updateLive(buttons, axes, id, now)
    return
  }

  const pressed = collectPressed(buttons, axes)

  // 方向连发（长按）
  const timing = { delay: prefs.repeatDelay, interval: prefs.repeatInterval }
  for (const { action, repeat } of repeatTracker.update(pressed, now, timing)) {
    emit(action, { repeat, pad })
  }

  // 非方向动作只在按下边沿触发
  for (const action of NON_DIRECTION_ACTIONS) {
    if (pressed.has(action) && !previousPressed.has(action)) emit(action, { repeat: false, pad })
  }

  injectedTaps.clear()
  previousPressed = pressed
  previousButtons = buttons
  updateLive(buttons, axes, id, now)
}

function frame(now) {
  if (!running) return
  frameId = requestAnimationFrame(frame)
  const pads = getPads()
  const pad = syncConnection(pads)
  if (!pad) {
    // 没有物理手柄时仍处理调试注入，方便在浏览器里验证导航
    if (injected.size || injectedTaps.size) {
      processFrame(now, { buttons: [], axes: [], id: 'virtual', pad: null })
    } else {
      resetInputState()
    }
    if (gamepad.mode) gamepad.mode = false
    return
  }
  processFrame(now, { ...readPad(pad), pad })
}

function onConnected(event) {
  const pad = event?.gamepad
  if (!pad) return
  setPointer(false)
  toastForPad(pad)
  if (gamepad.prefs.enabled) gamepad.mode = true
  resetInputState()
}

function onDisconnected(event) {
  const pad = event?.gamepad
  showToast('手柄已断开', pad?.id || '')
  if (!getPads().length) {
    setDevices([])
    gamepad.mode = false
  }
  resetInputState()
}

export function startEngine(onAction) {
  if (running) return stopEngine
  handler = onAction
  running = true
  resetInputState()
  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', onConnected)
    window.addEventListener('gamepaddisconnected', onDisconnected)
    frameId = requestAnimationFrame(frame)
  }
  return stopEngine
}

export function stopEngine() {
  if (!running) return
  running = false
  handler = null
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId)
  if (typeof window !== 'undefined') {
    window.removeEventListener('gamepadconnected', onConnected)
    window.removeEventListener('gamepaddisconnected', onDisconnected)
  }
  clearTimeout(captureTimer)
  captureTimer = null
  captured = null
  injected.clear()
  injectedTaps.clear()
  seenPads = new Set()
}

/** 等待用户按下一个物理按键（用于改键），超时回调 null */
export function captureNextButton(timeoutMs = 6000, callback = () => {}) {
  clearTimeout(captureTimer)
  captured = { callback }
  captureTimer = setTimeout(() => {
    captured = null
    captureTimer = null
    callback?.(null)
  }, Math.max(1000, timeoutMs))
}

export function cancelButtonCapture() {
  clearTimeout(captureTimer)
  captureTimer = null
  captured = null
}

/** 调试：直接注入逻辑动作（绕过物理手柄），无实体手柄时可在控制台验证 */
export function injectAction(action, pressed) {
  if (!Object.values(ACTION).includes(action)) return
  if (pressed) injected.add(action)
  else injected.delete(action)
}

export function injectTap(action, holdMs = 60) {
  if (!Object.values(ACTION).includes(action)) return
  injectedTaps.add(action)
  setTimeout(() => injectedTaps.delete(action), Math.max(30, holdMs))
}

export function isCapturing() {
  return Boolean(captured)
}
