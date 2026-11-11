/**
 * 焦点与空间导航：在可聚焦 DOM 元素之间移动、激活、滚动到可视区域。
 * 使用真实 DOM 焦点，保证键盘 / 读屏 / 现有交互不受影响。
 */
import { ACTION } from './constants.js'
import { gamepad, openOverlay } from './store.js'
import { pickDirection } from './spatial.js'

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"]):not([type="file"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const BLOCKED_ANCESTOR = '[inert],[aria-hidden="true"],[data-gp-skip]'
let focusedElement = null

export function isNavigable(el) {
  return Boolean(el && el.nodeType === 1 && el.matches?.(FOCUSABLE_SELECTOR) && !el.closest(BLOCKED_ANCESTOR))
}

/** 元素是否真实可见（有尺寸、未隐藏） */
export function isVisible(el) {
  if (!el || !el.isConnected || !isNavigable(el)) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = window.getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  return true
}

export function overlayRoot() {
  if (!gamepad.overlay) return null
  return document.querySelector('[data-gp-overlay]')
}

/** 当前焦点范围：浮层打开时限制在浮层内 */
export function focusRoot() {
  return overlayRoot() || document.body
}

export function collectFocusables(root = focusRoot()) {
  if (!root) return []
  const nodes = root.querySelectorAll(FOCUSABLE_SELECTOR)
  const list = []
  for (const node of nodes) {
    if (isVisible(node)) list.push(node)
  }
  return list
}

export function focused() {
  const active = document.activeElement
  return active && active !== document.body && isVisible(active) ? active : null
}

/** 当前没有有效焦点时，聚焦浮层 / 页面的默认落点 */
export function ensureFocus() {
  const root = focusRoot()
  const active = focused()
  if (active && (root === document.body || root.contains(active))) return active
  return focusDefault()
}

export function focusDefault() {
  const root = focusRoot()
  const preferred = root.querySelector?.('[data-gp-autofocus]')
  if (preferred && isVisible(preferred)) return focusElement(preferred) || preferred
  const main = root === document.body ? document.querySelector('main') || root : root
  const candidates = collectFocusables(main)
  if (candidates.length) return focusElement(candidates[0]) || candidates[0]
  const all = collectFocusables(root)
  return all.length ? focusElement(all[0]) || all[0] : null
}

export function focusElement(el, { scroll = true } = {}) {
  if (!el || typeof el.focus !== 'function') return false
  try {
    el.focus({ preventScroll: true })
  } catch {
    try { el.focus() } catch { return false }
  }
  if (scroll) scrollToElement(el)
  return true
}

export function scrollToElement(el) {
  if (!el?.scrollIntoView) return
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' })
  } catch {
    try { el.scrollIntoView() } catch { /* ignore */ }
  }
}

export function focusFirstIn(root) {
  if (!root) return null
  const preferred = root.querySelector('[data-gp-autofocus]')
  const target = preferred && isVisible(preferred) ? preferred : collectFocusables(root)[0]
  if (!target) return null
  focusElement(target)
  return target
}

/**
 * 向指定方向移动焦点。
 * @returns {Element|null}
 */
export function moveFocus(direction) {
  const root = focusRoot()
  const current = ensureFocus()
  if (!current) return null
  const currentRect = current.getBoundingClientRect()
  const candidates = []
  for (const [order, el] of collectFocusables(root).entries()) {
    if (el === current || el.contains(current)) continue
    if (current.contains(el)) continue
    candidates.push({ el, rect: el.getBoundingClientRect(), order })
  }
  const picked = pickDirection(currentRect, candidates, direction)
  if (!picked) return null
  focusElement(picked.el)
  return picked.el
}

/** 方向键作用于 select / range 时的内置调整（原生弹层无法被脚本控制；上下键仍用于移动焦点） */
export function adjustFocused(direction) {
  if (direction !== ACTION.LEFT && direction !== ACTION.RIGHT) return false
  const el = focused()
  if (!el) return false
  if (el.matches('select')) {
    cycleSelect(el, direction === ACTION.LEFT ? -1 : 1)
    return true
  }
  if (el.matches('input[type="range"]')) {
    const step = Number(el.step) || 1
    const min = Number(el.min) || 0
    const max = Number(el.max) || 100
    const delta = direction === ACTION.LEFT ? -step : step
    el.value = String(Math.min(max, Math.max(min, Number(el.value) + delta)))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  return false
}

export function cycleSelect(select, delta = 1) {
  const count = select?.options?.length || 0
  if (!count) return false
  const next = ((select.selectedIndex < 0 ? 0 : select.selectedIndex) + delta + count) % count
  if (next === select.selectedIndex) return false
  select.selectedIndex = next
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

/** 确认当前焦点：按钮/链接点击，文本框打开虚拟键盘，select 循环选项 */
export function activateFocused() {
  let el = focused()
  if (!el) el = ensureFocus()
  return activateElement(el)
}

export function activateElement(el) {
  if (!el || !isNavigable(el)) return false
  if (el.matches('input, textarea')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'range', 'color'].includes(type)) {
      el.click()
      return true
    }
    openOverlay({ kind: 'keyboard', target: el })
    return true
  }
  if (el.matches('select')) return cycleSelect(el, 1)
  el.click()
  return true
}

/** 给最近一次导航聚焦的元素打标记，CSS 用它做主机式高亮 */
export function installFocusTracking() {
  const onFocusIn = (event) => {
    const target = event.target
    if (focusedElement && focusedElement !== target) focusedElement.removeAttribute('data-gp-focused')
    if (isNavigable(target)) {
      focusedElement = target
      target.setAttribute('data-gp-focused', '')
    }
  }
  const onFocusOut = (event) => {
    const target = event.target
    if (focusedElement === target) {
      target.removeAttribute('data-gp-focused')
      focusedElement = null
    }
  }
  const clear = () => {
    if (focusedElement) focusedElement.removeAttribute('data-gp-focused')
    focusedElement = null
  }
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  return () => {
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    clear()
  }
}
