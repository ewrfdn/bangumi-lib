/**
 * 动作分发：把 engine 的逻辑动作交给 页面上下文 → 浮层 → 默认导航 处理。
 * 页面通过 useGamepadContext 注册自己的按键；浮层打开时焦点限制在浮层内。
 */
import { ACTION, DEFAULT_HINTS, DIRECTION_ACTIONS } from './constants.js'
import { closeOverlay, gamepad, openOverlay, setPointer } from './store.js'
import { injectAction, injectTap, startEngine } from './engine.js'
import {
  activateFocused,
  adjustFocused,
  focusDefault,
  focusElement,
  focusFirstIn,
  focused,
  installFocusTracking,
  isNavigable,
  moveFocus,
  overlayRoot,
} from './nav.js'

const contexts = []
let disposeEngine = null
let disposeFocus = null
let disposeRoute = null
let router = null

/** 主菜单页面：B 返回只在子页面生效，避免从主页面误退到浏览器历史/登录页。 */
const TOP_LEVEL_ROUTES = new Set(['home', 'library', 'browse', 'admin'])

/**
 * 当前路由是否禁用 B 返回。
 * 文件浏览页只有根目录算主页面；进入具体文件夹后仍允许返回上一级/上一页。
 */
export function backDisabledOn(route) {
  if (!route || typeof route !== 'object') return false
  const name = route.name
  if (!TOP_LEVEL_ROUTES.has(name)) return false
  if (name === 'browse') {
    const path = String(route.query?.path ?? '')
    return path === '' || path === '/'
  }
  return true
}

function currentRoute() {
  return router?.currentRoute?.value ?? null
}

function backDisabled() {
  return backDisabledOn(currentRoute())
}

export function registerGamepadContext(context = {}) {
  const entry = {
    id: context.id || `context-${contexts.length + 1}`,
    hints: context.hints && typeof context.hints === 'object' ? context.hints : {},
    handle: typeof context.handle === 'function' ? context.handle : null,
    // 浮层内组件注册的上下文只在浮层打开时生效，避免页面上下文抢走浮层按键
    overlay: Boolean(context.overlay),
    // 页面使用媒体控制焦点（如播放器）时，手柄连接后不要自动聚焦页面元素
    keepFocusless: Boolean(context.keepFocusless),
  }
  contexts.push(entry)
  refreshHints()
  return () => {
    const index = contexts.indexOf(entry)
    if (index >= 0) contexts.splice(index, 1)
    refreshHints()
  }
}

/** 当前页面是否要求「保持无焦点」（播放器的媒体控制模式） */
export function shouldSuppressAutoFocus() {
  if (gamepad.overlay) return false
  return contexts.some((context) => context.keepFocusless)
}

/** 合并上下文提示，供 GamepadHUD 展示 */
export function refreshHints() {
  const hints = { ...DEFAULT_HINTS }
  for (const context of contexts) Object.assign(hints, context.hints)
  if (gamepad.overlay) hints[ACTION.BACK] = '关闭'
  // 主页面没有可返回的层级：不展示 B 提示，按键也不生效
  else if (backDisabled()) delete hints[ACTION.BACK]
  if (!hints[ACTION.SETTINGS]) hints[ACTION.SETTINGS] = DEFAULT_HINTS[ACTION.SETTINGS]
  gamepad.hints = hints
}

export function dispatchAction(action, meta = {}) {
  // 1. 上下文动作优先（后注册的优先）；浮层打开时只让浮层组件自己的上下文响应
  const overlayOpen = Boolean(gamepad.overlay)
  for (let index = contexts.length - 1; index >= 0; index--) {
    const context = contexts[index]
    if (!context.handle || context.overlay !== overlayOpen) continue
    try {
      if (context.handle(action, meta) === true) return true
    } catch (error) {
      console.error(`[gamepad] context "${context.id}" failed:`, error)
    }
  }
  if (overlayOpen) return handleOverlayAction(action, meta)
  return handleDefaultAction(action, meta)
}

function handleOverlayAction(action) {
  const root = overlayRoot()
  if (!root) return true
  if (action === ACTION.BACK || action === ACTION.SETTINGS) {
    closeCurrentOverlay()
    return true
  }
  if (DIRECTION_ACTIONS.includes(action)) {
    moveFocus(action)
    return true
  }
  if (action === ACTION.CONFIRM) {
    activateFocused()
    return true
  }
  return false
}

function handleDefaultAction(action) {
  if (DIRECTION_ACTIONS.includes(action)) {
    if (adjustFocused(action)) return true
    if (!focused()) {
      // 第一次方向输入：先显示默认落点，不直接跳格
      focusDefault()
      return true
    }
    moveFocus(action)
    return true
  }
  if (action === ACTION.CONFIRM) {
    activateFocused()
    return true
  }
  if (action === ACTION.BACK) {
    if (backDisabled()) return true
    goBack()
    return true
  }
  if (action === ACTION.SETTINGS) {
    openOverlay({ kind: 'settings' })
    return true
  }
  if (action === ACTION.SEARCH) return focusSearch()
  return false
}

export function closeCurrentOverlay() {
  if (!gamepad.overlay) return false
  const restore = closeOverlay()
  refreshHints()
  // 等 Vue 把浮层卸载后恢复原焦点；原本没有焦点时保持无焦点（例如播放器的媒体控制模式）
  requestAnimationFrame(() => {
    if (restore && restore.isConnected && isNavigable(restore)) {
      focusElement(restore)
    } else if (restore && restore.isConnected && restore !== document.body) {
      focusDefault()
    }
  })
  return true
}

function goBack() {
  if (router) {
    const state = router.options?.history?.state
    if (state?.back) router.back()
    else router.push('/')
    return
  }
  if (window.history.length > 1) window.history.back()
}

function focusSearch() {
  const root = overlayRoot() || document.body
  const search = [...root.querySelectorAll('input[type="search"]')].find((el) => isNavigable(el) && el.getBoundingClientRect().width > 0)
  if (!search) return false
  focusElement(search)
  return true
}

/** 浮层打开后把焦点送进浮层（由 GamepadProvider 在 DOM 更新后调用） */
export function focusOverlay() {
  const root = overlayRoot()
  if (!root) return null
  return focusFirstIn(root)
}

export function installGamepad(options = {}) {
  router = options.router || null
  disposeFocus = installFocusTracking()
  disposeEngine = startEngine(dispatchAction)
  // 路由变化后主页面/子页面的 B 提示与返回行为要跟着变
  disposeRoute = typeof router?.afterEach === 'function' ? router.afterEach(() => refreshHints()) : null

  const onPointer = () => setPointer(true)
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || !gamepad.overlay) return
    event.preventDefault()
    closeCurrentOverlay()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('pointerdown', onPointer, { passive: true })
    window.addEventListener('keydown', onKeyDown, true)
    // 无实体手柄时的调试入口：__anishareGamepad.tap('down')
    window.__anishareGamepad = {
      actions: ACTION,
      press: (action) => injectAction(action, true),
      release: (action) => injectAction(action, false),
      tap: (action) => injectTap(action),
      state: gamepad,
      refresh: refreshHints,
    }
  }
  refreshHints()

  return () => {
    disposeEngine?.()
    disposeEngine = null
    disposeFocus?.()
    disposeFocus = null
    disposeRoute?.()
    disposeRoute = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKeyDown, true)
      delete window.__anishareGamepad
    }
    router = null
    contexts.length = 0
  }
}
