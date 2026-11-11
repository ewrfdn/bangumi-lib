<script setup>
/**
 * 手柄虚拟键盘浮层（由 Provider 以 v-if="gamepad.overlay?.kind === 'keyboard'" 渲染）。
 *
 * 目标输入框 = gamepad.overlay.target。字母 / 符号两套布局，方向键 + A 输入，
 * 支持空格、退格、清空、大写、布局切换、完成（保留修改）与取消（还原初值）。
 * 写回使用原生 value setter + input 事件，兼容 Vue v-model；光标位置固定在末尾。
 */
import { computed, ref } from 'vue'
import { KEYBOARD_LAYOUTS } from './constants.js'
import { useGamepad } from './useGamepad.js'

const { gamepad, closeOverlay } = useGamepad()

const target = (() => {
  const value = gamepad.overlay?.target
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement ? value : null
})()

const initialValue = target ? String(target.value ?? '') : ''
const currentValue = ref(initialValue)
const layout = ref('letters')
const shift = ref(false)

const inputType = String(target?.getAttribute?.('type') || 'text').toLowerCase()
const isPassword = inputType === 'password'
const maxLength = (() => {
  const raw = Number(target?.maxLength)
  return Number.isInteger(raw) && raw >= 0 ? raw : -1
})()

const rows = computed(() => KEYBOARD_LAYOUTS[layout.value] || [])
const layoutLabel = computed(() => (layout.value === 'letters' ? '符号' : '字母'))

const targetLabel = (() => {
  if (!target) return '文本输入'
  const aria = target.getAttribute('aria-label')?.trim()
  if (aria) return aria
  const labelledBy = target.getAttribute('aria-labelledby')?.trim()
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .join(' ')
      .trim()
    if (text) return text
  }
  const labels = target.labels && target.labels.length ? target.labels[0].textContent?.trim() : ''
  if (labels) return labels
  const wrapping = target.closest?.('label')?.textContent?.trim()
  if (wrapping) return wrapping
  const placeholder = target.getAttribute('placeholder')?.trim()
  if (placeholder) return placeholder
  return target.getAttribute('name')?.trim() || '文本输入'
})()

const displayValue = computed(() => {
  const value = currentValue.value
  if (!value) return ''
  if (!isPassword) return value
  return `${'•'.repeat(Math.min(value.length, 60))}${value.length > 60 ? '…' : ''}`
})

function nativeValueSetter(el) {
  try {
    if (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set || null
    }
    if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) {
      return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || null
    }
  } catch { /* 非标准元素退回到普通赋值 */ }
  return null
}

/** 写回输入框：原生 setter + input 事件，Vue v-model 能同步 */
function writeValue(rawNext) {
  const el = target
  if (!el) return
  let next = String(rawNext ?? '')
  if (maxLength >= 0) next = next.slice(0, maxLength)
  currentValue.value = next
  try {
    const setter = nativeValueSetter(el)
    if (setter) setter.call(el, next)
    else el.value = next
  } catch {
    try { el.value = next } catch { return }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 光标固定在末尾：在已有内容后追加 */
function insert(text) {
  if (!target) return
  writeValue(String(target.value ?? '') + text)
}

function displayKey(key) {
  return shift.value && layout.value === 'letters' && /^[a-z]$/.test(key) ? key.toUpperCase() : key
}

function pressKey(key) {
  insert(displayKey(key))
}

function backspace() {
  if (!target) return
  const value = String(target.value ?? '')
  if (!value) return
  writeValue(value.slice(0, -1))
}

function clearAll() {
  if (!target) return
  writeValue('')
}

function toggleLayout() {
  layout.value = layout.value === 'letters' ? 'symbols' : 'letters'
}

function toggleShift() {
  shift.value = !shift.value
}

/** 完成：保留当前内容，关闭浮层并恢复打开前的焦点 */
function finish() {
  closeOverlay()
}

/** 取消：还原打开时的初值后关闭浮层 */
function cancel() {
  if (target) writeValue(initialValue)
  closeOverlay()
}
</script>

<template>
  <div
    class="gp-overlay"
    data-gp-overlay
    role="dialog"
    aria-modal="true"
    aria-labelledby="gp-keyboard-title"
  >
    <div class="kb-panel">
      <header class="kb-header">
        <span class="kb-logo" aria-hidden="true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2.5" />
            <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
          </svg>
        </span>
        <div class="kb-heading">
          <h2 id="gp-keyboard-title" class="kb-title">手柄键盘</h2>
          <p class="kb-target" :title="targetLabel">{{ targetLabel }}</p>
        </div>
        <button type="button" class="kb-close" aria-label="取消输入并关闭" title="取消并关闭" @click="cancel">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>

      <div v-if="target" class="kb-body">
        <div class="kb-preview">
          <div class="kb-preview-head">
            <span>当前内容</span>
            <span class="mono">{{ currentValue.length }} 字符<template v-if="maxLength >= 0"> / {{ maxLength }}</template></span>
          </div>
          <div class="kb-value mono" :class="{ empty: !currentValue, masked: isPassword }" role="status" aria-live="polite">
            {{ displayValue || '（空）' }}
          </div>
          <p class="kb-preview-note">
            {{ isPassword ? '密码已遮蔽显示' : '输入会追加到末尾' }}<template v-if="maxLength >= 0">，最多 {{ maxLength }} 个字符</template>。
          </p>
        </div>

        <div class="kb-keyboard" role="group" aria-label="虚拟键盘">
          <div v-for="(row, rowIndex) in rows" :key="`${layout}-${rowIndex}`" class="kb-row">
            <button
              v-for="(key, keyIndex) in row"
              :key="`${rowIndex}-${keyIndex}`"
              type="button"
              class="kb-key"
              :data-gp-autofocus="rowIndex === 0 && keyIndex === 0 ? '' : undefined"
              @click="pressKey(key)"
            >{{ displayKey(key) }}</button>
          </div>
        </div>

        <div class="kb-actions" role="group" aria-label="键盘操作">
          <button type="button" class="kb-action" @click="insert(' ')">空格</button>
          <button type="button" class="kb-action" @click="backspace">退格</button>
          <button type="button" class="kb-action" @click="clearAll">清空</button>
          <button type="button" class="kb-action" @click="toggleLayout">{{ layoutLabel }}</button>
          <button type="button" class="kb-action" :aria-pressed="shift" @click="toggleShift">大写</button>
          <button type="button" class="kb-action primary" @click="finish">完成</button>
          <button type="button" class="kb-action danger" @click="cancel">取消</button>
        </div>
      </div>

      <div v-else class="kb-body kb-body-empty">
        <p class="kb-fallback">输入框已失效，请关闭后重新打开。</p>
        <button type="button" class="kb-action" @click="closeOverlay">关闭</button>
      </div>

      <footer class="kb-footer">
        <span class="kb-footer-hint"><kbd>A</kbd><span>输入</span><span class="kb-footer-sep">·</span><kbd>B</kbd><span>关闭</span></span>
        <span class="kb-footer-note">摇杆 / 方向键移动</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.gp-overlay {
  position: fixed;
  inset: 0;
  z-index: 92;
  display: grid;
  place-items: center;
  padding: calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
  background: #050508cc;
  backdrop-filter: blur(7px);
}

.kb-panel {
  display: flex;
  width: min(760px, 100%);
  max-height: 86vh;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: linear-gradient(180deg, #15151d, #101016);
  box-shadow: var(--shadow);
}

.kb-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--line);
}

.kb-logo {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border: 1px solid #a78bfa35;
  border-radius: 9px;
  background: #a78bfa14;
  color: var(--accent);
}

.kb-heading {
  flex: 1;
  min-width: 0;
}

.kb-title {
  margin: 0;
  font-size: 15px;
  font-weight: 550;
  letter-spacing: .2px;
}

.kb-target {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-close {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
}

.kb-close:hover {
  border-color: var(--line);
  background: #ffffff08;
  color: var(--text);
}

.kb-body {
  flex: 1;
  min-height: 0;
  padding: 14px 16px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.kb-body-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 160px;
}

.kb-fallback {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}

.kb-preview {
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #0b0b10;
}

.kb-preview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-faint);
  font-size: 10px;
}

.kb-value {
  min-height: 24px;
  max-height: 72px;
  margin-top: 6px;
  overflow-y: auto;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
  word-break: break-all;
}

.kb-value.empty {
  color: var(--text-faint);
}

.kb-value.masked {
  letter-spacing: 2px;
}

.kb-preview-note {
  margin: 6px 0 0;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

.kb-keyboard {
  display: flex;
  max-width: 640px;
  flex-direction: column;
  gap: 6px;
  margin: 14px auto 0;
}

.kb-row {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.kb-key {
  display: flex;
  width: 100%;
  max-width: 58px;
  height: 40px;
  min-width: 0;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: #ffffff07;
  color: var(--text);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 14px;
  transition: background .1s, border-color .1s, transform .1s;
}

.kb-key:hover {
  border-color: #a78bfa55;
  background: #a78bfa1a;
}

.kb-key:active {
  background: #a78bfa2e;
  transform: translateY(1px);
}

.kb-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

.kb-action {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  padding: 0 13px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  transition: background .15s, border-color .15s;
}

.kb-action:hover {
  border-color: #a78bfa55;
  background: var(--bg-elev-2);
}

.kb-action[aria-pressed="true"] {
  border-color: #a78bfa55;
  background: #a78bfa1a;
  color: #d8caff;
}

.kb-action.primary {
  border-color: #9c7cf4;
  background: #9c7cf4;
  color: #fff;
}

.kb-action.primary:hover {
  background: #ad90ff;
}

.kb-action.danger {
  border-color: #e594a12e;
  background: #e594a10a;
  color: #efb0b9;
}

.kb-action.danger:hover {
  border-color: #e594a155;
  background: #e594a114;
}

.kb-footer {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  padding: 9px 16px;
  border-top: 1px solid var(--line);
  background: #0d0d13;
  color: var(--text-faint);
  font-size: 10px;
}

.kb-footer-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.kb-footer kbd {
  display: inline-flex;
  min-width: 17px;
  height: 17px;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border: 1px solid #ffffff22;
  border-bottom-width: 2px;
  border-radius: 3px;
  background: #ffffff0a;
  color: #ddd9ea;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 9px;
}

.kb-footer-sep {
  color: var(--text-faint);
}

.kb-footer-note {
  margin-left: auto;
}

@media (max-width: 560px) {
  .gp-overlay {
    padding: 10px;
  }

  .kb-panel {
    max-height: 94vh;
  }

  .kb-header {
    padding: 11px 13px;
  }

  .kb-body {
    padding: 12px 11px 13px;
  }

  .kb-row {
    gap: 4px;
  }

  .kb-key {
    height: 34px;
    font-size: 12px;
  }

  .kb-actions {
    gap: 5px;
    margin-top: 12px;
    padding-top: 11px;
  }

  .kb-action {
    min-height: 31px;
    padding: 0 10px;
    font-size: 10px;
  }

  .kb-footer {
    padding: 8px 12px;
  }

  .kb-footer-note {
    margin-left: 0;
  }
}
</style>
