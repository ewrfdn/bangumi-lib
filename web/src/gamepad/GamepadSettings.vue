<script setup>
/**
 * 手柄设置浮层（由 Provider 以 v-if="gamepad.overlay?.kind === 'settings'" 渲染）。
 *
 * 配置分区：设备状态 / 开关 / 摇杆与连发 / 按键映射 / 按键测试 / 恢复默认。
 * 所有交互元素都是原生 button 或 input[type=range]，方便手柄空间导航；
 * 修改即时写入 store（savePrefs / resetPrefs），没有独立保存按钮。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ACTION, BUTTON_LABELS, DEFAULT_MAP, MAP_PRESETS, PREF_LIMITS } from './constants.js'
import { useGamepad } from './useGamepad.js'

const { gamepad, closeOverlay, savePrefs, resetPrefs, captureNextButton, cancelButtonCapture } = useGamepad()

/** 可改键的动作（方向动作固定为十字键 / 摇杆，不参与映射） */
const MAP_ACTIONS = [
  { action: ACTION.CONFIRM, label: '确认', desc: '点击按钮、链接，或打开输入框虚拟键盘' },
  { action: ACTION.BACK, label: '返回', desc: '关闭浮层；没有浮层时后退' },
  { action: ACTION.CONTEXT, label: '上下文动作', desc: '播放器循环字幕等页面动作' },
  { action: ACTION.MENU, label: '菜单 / 播放设置', desc: '播放器打开播放设置浮层' },
  { action: ACTION.SEARCH, label: '搜索', desc: '聚焦当前页面的搜索框' },
  { action: ACTION.PREV_TAB, label: '上一个页签', desc: '切换页签 / 上一集' },
  { action: ACTION.NEXT_TAB, label: '下一个页签', desc: '切换页签 / 下一集' },
  { action: ACTION.FULLSCREEN, label: '全屏 / 退出全屏', desc: '播放器中切换视频全屏（默认截图键）' },
  { action: ACTION.SETTINGS, label: '手柄设置', desc: '打开本设置浮层' },
]

const SWITCHES = [
  { key: 'enabled', label: '启用手柄模式', desc: '检测到手柄时自动高亮当前选中项' },
  { key: 'hintBar', label: '显示按键提示条', desc: '屏幕底部显示当前页面的按键提示' },
  { key: 'hideCursor', label: '隐藏鼠标指针', desc: '最近一次输入来自手柄时隐藏光标' },
  { key: 'vibration', label: '震动反馈', desc: '手柄支持时在按键时轻微震动' },
]

const SLIDERS = [
  {
    key: 'deadzone',
    label: '摇杆死区',
    hint: '低于该值的方向输入会被忽略，避免摇杆漂移',
    min: PREF_LIMITS.deadzone[0],
    max: PREF_LIMITS.deadzone[1],
    step: PREF_LIMITS.deadzone[2],
    format: (value) => Number(value).toFixed(2),
  },
  {
    key: 'repeatDelay',
    label: '连发延迟',
    hint: '按住方向后开始连续移动前的等待时间',
    min: PREF_LIMITS.repeatDelay[0],
    max: PREF_LIMITS.repeatDelay[1],
    step: PREF_LIMITS.repeatDelay[2],
    format: (value) => `${Math.round(Number(value))} ms`,
  },
  {
    key: 'repeatInterval',
    label: '连发间隔',
    hint: '长按方向时每次移动的间隔',
    min: PREF_LIMITS.repeatInterval[0],
    max: PREF_LIMITS.repeatInterval[1],
    step: PREF_LIMITS.repeatInterval[2],
    format: (value) => `${Math.round(Number(value))} ms`,
  },
]

const STICKS = [
  { value: 'left', label: '左摇杆' },
  { value: 'right', label: '右摇杆' },
]

const presets = Object.values(MAP_PRESETS)

const devices = computed(() => (Array.isArray(gamepad.devices) ? gamepad.devices : []))

/** 实时按键测试：标准映射里的全部按键（含截图键）的亮灭状态 */
const liveKeys = computed(() => Array.from({ length: BUTTON_LABELS.length }, (_, index) => ({
  index,
  label: BUTTON_LABELS[index] || `#${index}`,
  pressed: Boolean(gamepad.live?.buttons?.[index]),
})))

/** 实时按键测试：前 4 个轴的 -1~1 进度条 */
const axisRows = computed(() => Array.from({ length: 4 }, (_, index) => {
  const raw = Number(gamepad.live?.axes?.[index])
  const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
  return {
    index,
    value,
    left: 50 + Math.min(value, 0) * 50,
    width: Math.abs(value) * 50,
  }
}))

const liveReady = computed(() => Boolean(gamepad.live?.buttons?.length || gamepad.live?.axes?.length))

const capturing = ref('')
const notice = ref('')
const confirmingReset = ref(false)

let noticeTimer = null
let resetTimer = null

function flash(text) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 3200)
}

function toggleSwitch(key) {
  savePrefs({ [key]: !gamepad.prefs[key] })
}

function setStick(value) {
  if (gamepad.prefs.stick !== value) savePrefs({ stick: value })
}

function onSliderInput(key, event) {
  savePrefs({ [key]: Number(event.target.value) })
}

function keyName(action) {
  const index = Number(gamepad.prefs.map?.[action])
  if (!Number.isInteger(index) || index < 0) return '未设置'
  return BUTTON_LABELS[index] || `按键 ${index}`
}

/** 改键期间 / 结束后把焦点留在同一行，避免手柄导航丢失落点 */
function focusMapRow(action) {
  nextTick(() => {
    try {
      const row = document.querySelector(`[data-gp-overlay] [data-map-action="${action}"]`)
      const button = row?.querySelector?.('.gp-map-button')
      if (button) button.focus({ preventScroll: true })
    } catch { /* 元素已卸载时忽略 */ }
  })
}

function startCapture(item) {
  if (capturing.value) return
  capturing.value = item.action
  captureNextButton(5000, (index) => {
    if (capturing.value !== item.action) return
    capturing.value = ''
    if (index === null || index === undefined) {
      flash(`「${item.label}」改键超时，已取消`)
    } else {
      savePrefs({ map: { ...gamepad.prefs.map, [item.action]: index } })
      flash(`已将「${item.label}」设为 ${BUTTON_LABELS[index] || `按键 ${index}`}`)
    }
    focusMapRow(item.action)
  })
}

function stopCapture() {
  if (!capturing.value) return
  const action = capturing.value
  cancelButtonCapture()
  capturing.value = ''
  flash('已取消改键')
  focusMapRow(action)
}

function resetMap() {
  if (capturing.value) stopCapture()
  savePrefs({ map: { ...DEFAULT_MAP } })
  flash('已恢复默认按键映射')
}

function applyPreset(preset) {
  if (capturing.value) stopCapture()
  savePrefs({ map: { ...preset.map } })
  flash(`已应用「${preset.label}」`)
}

function requestReset() {
  if (!confirmingReset.value) {
    confirmingReset.value = true
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => { confirmingReset.value = false }, 4000)
    return
  }
  clearTimeout(resetTimer)
  confirmingReset.value = false
  if (capturing.value) stopCapture()
  resetPrefs()
  flash('已恢复默认设置')
}

onBeforeUnmount(() => {
  cancelButtonCapture()
  clearTimeout(noticeTimer)
  clearTimeout(resetTimer)
})
</script>

<template>
  <div
    class="gp-overlay"
    data-gp-overlay
    role="dialog"
    aria-modal="true"
    aria-labelledby="gp-settings-title"
  >
    <div class="gp-panel">
      <header class="gp-header">
        <span class="gp-logo" aria-hidden="true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c0 .05-.01.1-.02.15C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.68-7.26l-.02-.15A4 4 0 0 0 17.32 5Z" />
            <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
          </svg>
        </span>
        <div class="gp-heading">
          <h2 id="gp-settings-title" class="gp-title">手柄设置</h2>
          <p class="gp-subtitle">所有修改立即保存到本机浏览器，无需单独确定。</p>
        </div>
        <button type="button" class="gp-close" aria-label="关闭手柄设置" title="关闭" @click="closeOverlay">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>

      <div class="gp-body">
        <!-- a. 设备状态 -->
        <section class="gp-section" aria-labelledby="gp-devices-title">
          <div class="gp-section-head">
            <h3 id="gp-devices-title">设备状态</h3>
            <span class="gp-tag" :class="gamepad.connected ? 'ok' : ''">{{ gamepad.connected ? '已连接' : '未连接' }}</span>
          </div>

          <div v-if="gamepad.connected" class="gp-device-main">
            <span class="gp-dot" :class="{ ok: gamepad.connected }" aria-hidden="true" />
            <div class="gp-device-copy">
              <strong>{{ gamepad.mapping === 'standard' ? '标准映射手柄' : '非标准映射手柄' }}</strong>
              <span class="mono gp-device-id">{{ gamepad.id || '未知设备' }}</span>
            </div>
          </div>
          <p v-else class="gp-hint">尚未检测到手柄。按手柄任意键唤醒；若没有反应，请检查连接后重新插拔。</p>

          <ul v-if="devices.length" class="gp-device-list" aria-label="已连接的手柄列表">
            <li v-for="device in devices" :key="device.index" class="gp-device-item">
              <span class="mono gp-device-index">#{{ Number(device.index) + 1 }}</span>
              <span class="gp-device-id">{{ device.id || '未知设备' }}</span>
              <span class="gp-tag" :class="device.mapping === 'standard' ? 'ok' : ''">{{ device.mapping === 'standard' ? '标准映射' : '非标准映射' }}</span>
            </li>
          </ul>

          <p v-if="!gamepad.supported" class="gp-alert" role="alert">当前浏览器不提供 Gamepad API</p>
          <p v-if="!gamepad.secure" class="gp-alert warn" role="alert">当前页面不是安全上下文（HTTPS / localhost），Firefox 等浏览器会屏蔽手柄 API；请用 HTTPS 或 localhost 访问。</p>
        </section>

        <!-- b. 开关 -->
        <section class="gp-section" aria-labelledby="gp-switches-title">
          <div class="gp-section-head">
            <h3 id="gp-switches-title">开关</h3>
          </div>
          <div class="gp-switch-grid">
            <button
              v-for="item in SWITCHES"
              :key="item.key"
              type="button"
              class="gp-switch"
              :aria-pressed="gamepad.prefs[item.key] === true"
              :data-gp-autofocus="item.key === 'enabled' ? '' : null"
              @click="toggleSwitch(item.key)"
            >
              <span class="gp-switch-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.desc }}</small>
              </span>
              <span class="gp-toggle" aria-hidden="true"><span class="gp-toggle-thumb" /></span>
            </button>
          </div>
        </section>

        <!-- c. 摇杆与连发 -->
        <section class="gp-section" aria-labelledby="gp-stick-title">
          <div class="gp-section-head">
            <h3 id="gp-stick-title">摇杆与连发</h3>
            <span class="gp-section-note">长按方向时生效</span>
          </div>
          <div class="gp-sliders">
            <label v-for="slider in SLIDERS" :key="slider.key" class="gp-slider">
              <span class="gp-slider-head">
                <span>{{ slider.label }}</span>
                <output class="gp-slider-value mono">{{ slider.format(gamepad.prefs[slider.key]) }}</output>
              </span>
              <input
                type="range"
                :min="slider.min"
                :max="slider.max"
                :step="slider.step"
                :value="gamepad.prefs[slider.key]"
                :aria-label="slider.label"
                @input="onSliderInput(slider.key, $event)"
              />
              <small class="gp-slider-hint">{{ slider.hint }}</small>
            </label>
          </div>

          <div class="gp-inline-row">
            <span class="gp-inline-label">使用摇杆</span>
            <div class="gp-segmented" role="group" aria-label="使用摇杆">
              <button
                v-for="stick in STICKS"
                :key="stick.value"
                type="button"
                class="gp-segment"
                :aria-pressed="gamepad.prefs.stick === stick.value"
                @click="setStick(stick.value)"
              >{{ stick.label }}</button>
            </div>
          </div>
          <div class="gp-inline-row">
            <span class="gp-inline-label">反转 Y 轴</span>
            <div class="gp-segmented" role="group" aria-label="反转 Y 轴">
              <button type="button" class="gp-segment" :aria-pressed="gamepad.prefs.invertY === false" @click="savePrefs({ invertY: false })">关闭</button>
              <button type="button" class="gp-segment" :aria-pressed="gamepad.prefs.invertY === true" @click="savePrefs({ invertY: true })">开启</button>
            </div>
          </div>
        </section>

        <!-- d. 按键映射 -->
        <section class="gp-section" aria-labelledby="gp-map-title">
          <div class="gp-section-head">
            <h3 id="gp-map-title">按键映射</h3>
            <span class="gp-section-note">方向键固定为十字键 / 摇杆</span>
          </div>

          <ul class="gp-map-list">
            <li
              v-for="item in MAP_ACTIONS"
              :key="item.action"
              class="gp-map-row"
              :class="{ capturing: capturing === item.action }"
              :data-map-action="item.action"
            >
              <div class="gp-map-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.desc }}</small>
              </div>

              <template v-if="capturing === item.action">
                <span class="gp-capture-text" role="status">请按下手柄上的新按键…</span>
                <button type="button" class="gp-btn small" @click="stopCapture">取消</button>
              </template>
              <template v-else>
                <kbd class="gp-keycap">{{ keyName(item.action) }}</kbd>
                <button type="button" class="gp-btn small gp-map-button" :disabled="Boolean(capturing)" @click="startCapture(item)">
                  {{ capturing ? '等待按键…' : '修改' }}
                </button>
              </template>
            </li>
          </ul>

          <div class="gp-map-actions">
            <button type="button" class="gp-btn" @click="resetMap">恢复默认映射</button>
            <button v-for="preset in presets" :key="preset.label" type="button" class="gp-btn" @click="applyPreset(preset)">
              {{ preset.label }}
            </button>
          </div>
        </section>

        <!-- e. 按键测试 -->
        <section class="gp-section" aria-labelledby="gp-test-title">
          <div class="gp-section-head">
            <h3 id="gp-test-title">按键测试</h3>
            <span class="gp-section-note">仅在本页打开时实时刷新</span>
          </div>

          <div class="gp-key-grid" aria-label="按键状态">
            <span
              v-for="key in liveKeys"
              :key="key.index"
              class="gp-live-key"
              :class="{ on: key.pressed }"
            >
              <span class="gp-live-dot" aria-hidden="true" />{{ key.label }}
            </span>
          </div>

          <ul class="gp-axis-list" aria-label="摇杆轴值">
            <li v-for="axis in axisRows" :key="axis.index" class="gp-axis">
              <span class="gp-axis-name mono">轴 {{ axis.index }}</span>
              <span class="gp-axis-track" aria-hidden="true">
                <span class="gp-axis-center" />
                <span class="gp-axis-fill" :style="{ left: axis.left + '%', width: axis.width + '%' }" />
              </span>
              <span class="gp-axis-value mono">{{ axis.value.toFixed(2) }}</span>
            </li>
          </ul>
          <p v-if="!liveReady" class="gp-hint">等待手柄输入…</p>
        </section>
      </div>

      <!-- f. 恢复默认与调试提示 -->
      <footer class="gp-footer">
        <button type="button" class="gp-btn danger" @click="requestReset">
          {{ confirmingReset ? '再次点击确认恢复默认设置' : '恢复默认设置' }}
        </button>
        <p class="gp-notice" role="status" aria-live="polite">{{ notice }}</p>
        <p class="gp-debug">
          无手柄时可在控制台执行 <code>__anishareGamepad.tap('down')</code> 测试导航。
        </p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.gp-overlay {
  position: fixed;
  inset: 0;
  z-index: 91;
  display: grid;
  place-items: center;
  padding: calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
  background: #050508cc;
  backdrop-filter: blur(7px);
}

.gp-panel {
  display: flex;
  width: min(820px, 100%);
  max-height: 86vh;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: linear-gradient(180deg, #15151d, #101016);
  box-shadow: var(--shadow);
}

.gp-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}

.gp-logo {
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

.gp-heading {
  flex: 1;
  min-width: 0;
}

.gp-title {
  margin: 0;
  font-size: 15px;
  font-weight: 550;
  letter-spacing: .2px;
}

.gp-subtitle {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}

.gp-close {
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

.gp-close:hover {
  border-color: var(--line);
  background: #ffffff08;
  color: var(--text);
}

.gp-body {
  flex: 1;
  min-height: 0;
  padding: 4px 18px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.gp-section {
  margin-top: 12px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #ffffff03;
}

.gp-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-bottom: 10px;
}

.gp-section-head h3 {
  margin: 0;
  color: var(--text);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: .3px;
}

.gp-section-note {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
}

.gp-tag {
  display: inline-flex;
  min-height: 19px;
  align-items: center;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #ffffff05;
  color: var(--text-dim);
  font-size: 10px;
  white-space: nowrap;
}

.gp-tag.ok {
  border-color: #a78bfa35;
  background: #a78bfa10;
  color: #c5b2fa;
}

.gp-device-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gp-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #5f5c6b;
}

.gp-dot.ok {
  background: var(--accent);
  box-shadow: 0 0 0 3px #a78bfa18;
}

.gp-device-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.gp-device-copy strong {
  font-size: 12px;
  font-weight: 450;
}

.gp-device-id {
  color: var(--text-faint);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.gp-device-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.gp-device-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff04;
  font-size: 11px;
}

.gp-device-index {
  color: var(--text-faint);
  font-size: 10px;
}

.gp-hint {
  margin: 9px 0 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}

.gp-alert {
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid #e594a128;
  border-radius: 6px;
  background: #e594a10a;
  color: #efb0b9;
  font-size: 11px;
  line-height: 1.7;
}

.gp-alert.warn {
  border-color: #d9b47c28;
  background: #d9b47c09;
  color: #e3c49c;
}

.gp-switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.gp-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff04;
  text-align: left;
  transition: border-color .15s, background .15s;
}

.gp-switch:hover {
  border-color: #a78bfa45;
  background: #ffffff07;
}

.gp-switch[aria-pressed="true"] {
  border-color: #a78bfa45;
  background: #a78bfa0d;
}

.gp-switch-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.gp-switch-copy strong {
  color: var(--text);
  font-size: 12px;
  font-weight: 450;
}

.gp-switch-copy small {
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

.gp-toggle {
  position: relative;
  width: 30px;
  height: 17px;
  flex: none;
  border-radius: 999px;
  background: #ffffff12;
  transition: background .15s;
}

.gp-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #8b879a;
  transition: transform .15s, background .15s;
}

.gp-switch[aria-pressed="true"] .gp-toggle {
  background: #a78bfa55;
}

.gp-switch[aria-pressed="true"] .gp-toggle-thumb {
  background: #d8caff;
  transform: translateX(13px);
}

.gp-sliders {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.gp-slider {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.gp-slider-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-dim);
  font-size: 12px;
}

.gp-slider-value {
  color: #c9b8ff;
  font-size: 11px;
}

.gp-slider input[type="range"] {
  width: 100%;
  height: 18px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.gp-slider-hint {
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

.gp-inline-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.gp-inline-label {
  flex: 1;
  color: var(--text-dim);
  font-size: 12px;
}

.gp-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #ffffff04;
}

.gp-segment {
  min-height: 26px;
  padding: 0 11px;
  border-radius: 5px;
  color: var(--text-dim);
  font-size: 11px;
  transition: background .15s, color .15s;
}

.gp-segment:hover {
  color: var(--text);
  background: #ffffff06;
}

.gp-segment[aria-pressed="true"] {
  background: #a78bfa1f;
  color: #d8caff;
}

.gp-map-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.gp-map-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #ffffff03;
}

.gp-map-row.capturing {
  border-color: #a78bfa55;
  background: #a78bfa0e;
}

.gp-map-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.gp-map-copy strong {
  color: var(--text);
  font-size: 12px;
  font-weight: 450;
}

.gp-map-copy small {
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

.gp-keycap {
  display: inline-flex;
  min-width: 34px;
  height: 23px;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  border: 1px solid #ffffff20;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #ffffff08;
  color: #ddd9ea;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  white-space: nowrap;
}

.gp-capture-text {
  min-width: 0;
  color: #d8caff;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.gp-map-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 11px;
}

.gp-btn {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  transition: background .15s, border-color .15s;
}

.gp-btn:hover {
  border-color: #a78bfa55;
  background: var(--bg-elev-2);
}

.gp-btn:disabled {
  opacity: .4;
}

.gp-btn.small {
  min-height: 26px;
  padding: 0 9px;
  font-size: 10px;
}

.gp-btn.danger {
  border-color: #e594a12e;
  background: #e594a10a;
  color: #efb0b9;
}

.gp-btn.danger:hover {
  border-color: #e594a155;
  background: #e594a114;
}

.gp-key-grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 5px;
}

.gp-live-key {
  display: inline-flex;
  min-height: 27px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #ffffff04;
  color: var(--text-faint);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  transition: background .08s, color .08s, border-color .08s;
}

.gp-live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #3a3846;
}

.gp-live-key.on {
  border-color: #c9b8ff;
  background: #c9b8ff;
  color: #0b0b10;
}

.gp-live-key.on .gp-live-dot {
  background: #5b4b8f;
}

.gp-axis-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.gp-axis {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 9px;
  color: var(--text-faint);
  font-size: 10px;
}

.gp-axis-track {
  position: relative;
  height: 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #ffffff08;
}

.gp-axis-center {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  z-index: 1;
  width: 1px;
  background: #ffffff1c;
}

.gp-axis-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 2px;
  background: var(--accent);
  opacity: .75;
}

.gp-axis-value {
  color: var(--text-dim);
  font-size: 10px;
  text-align: right;
}

.gp-footer {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  background: #0d0d13;
}

.gp-notice {
  flex: 1;
  min-width: 120px;
  min-height: 15px;
  margin: 0;
  color: var(--accent);
  font-size: 10px;
  line-height: 1.5;
}

.gp-debug {
  flex-basis: 100%;
  margin: 0;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.7;
}

.gp-debug code {
  padding: 1px 4px;
  border-radius: 3px;
  background: #a78bfa0f;
  color: #b9a7e9;
  font-family: ui-monospace, Consolas, monospace;
  overflow-wrap: anywhere;
}

@media (max-width: 680px) {
  .gp-overlay {
    padding: 10px;
  }

  .gp-panel {
    max-height: 92vh;
  }

  .gp-header {
    padding: 12px 14px;
  }

  .gp-body {
    padding: 4px 13px 14px;
  }

  .gp-footer {
    padding: 11px 14px;
  }

  .gp-switch-grid {
    grid-template-columns: 1fr;
  }

  .gp-key-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .gp-map-row {
    gap: 8px;
    padding: 8px;
  }

  .gp-section-note {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
