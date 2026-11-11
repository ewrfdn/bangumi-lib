/** 手柄按键索引（W3C 标准映射） */
export const BUTTON = Object.freeze({
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
  /** Xbox Series / PlayStation 等手柄的截图 / 分享键（W3C 标准映射的可选按键 17） */
  SHARE: 17,
})

export const BUTTON_LABELS = Object.freeze(['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', '视图', '菜单', 'L3', 'R3', '↑', '↓', '←', '→', 'HOME', '截图'])

/** 逻辑动作：页面和浮层只关心动作名，不关心物理按键 */
export const ACTION = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  CONFIRM: 'confirm',
  BACK: 'back',
  CONTEXT: 'context',
  MENU: 'menu',
  SEARCH: 'search',
  PREV_TAB: 'prev-tab',
  NEXT_TAB: 'next-tab',
  SETTINGS: 'settings',
  FULLSCREEN: 'fullscreen',
})

export const DIRECTION_ACTIONS = Object.freeze([ACTION.UP, ACTION.DOWN, ACTION.LEFT, ACTION.RIGHT])
export const DIRECTION_LABELS = Object.freeze({ up: '上', down: '下', left: '左', right: '右' })

export const STORAGE_KEY = 'anishare.gamepad.v1'

/** 默认物理按键映射：标准手柄布局（Xbox / PlayStation 通用） */
export const DEFAULT_MAP = Object.freeze({
  [ACTION.CONFIRM]: BUTTON.A,
  [ACTION.BACK]: BUTTON.B,
  [ACTION.CONTEXT]: BUTTON.X,
  [ACTION.MENU]: BUTTON.Y,
  [ACTION.PREV_TAB]: BUTTON.LB,
  [ACTION.NEXT_TAB]: BUTTON.RB,
  [ACTION.SETTINGS]: BUTTON.START,
  [ACTION.SEARCH]: BUTTON.BACK,
  [ACTION.FULLSCREEN]: BUTTON.SHARE,
})

export const DEFAULT_HINTS = Object.freeze({
  [ACTION.CONFIRM]: '选择',
  [ACTION.BACK]: '返回',
  [ACTION.SETTINGS]: '手柄设置',
})

/** 提示条展示顺序：先显示页面上下文动作，再显示固定动作与方向提示 */
export const HINT_ORDER = Object.freeze([
  ACTION.CONFIRM,
  ACTION.BACK,
  ACTION.CONTEXT,
  ACTION.FULLSCREEN,
  ACTION.SEARCH,
  ACTION.MENU,
  ACTION.PREV_TAB,
  ACTION.NEXT_TAB,
  ACTION.UP,
  ACTION.DOWN,
  ACTION.LEFT,
  ACTION.RIGHT,
  ACTION.SETTINGS,
])

export const DEFAULT_PREFS = Object.freeze({
  enabled: true,
  deadzone: 0.28,
  repeatDelay: 420,
  repeatInterval: 120,
  vibration: true,
  hintBar: true,
  hideCursor: true,
  invertY: false,
  stick: 'left',
  map: { ...DEFAULT_MAP },
})

/** 预设布局：Switch 手柄 A/B 位置相反 */
export const MAP_PRESETS = Object.freeze({
  xbox: { label: '标准布局（Xbox / PlayStation）', map: { ...DEFAULT_MAP } },
  switch: {
    label: 'Switch 布局（A/B 交换）',
    map: { ...DEFAULT_MAP, [ACTION.CONFIRM]: BUTTON.B, [ACTION.BACK]: BUTTON.A },
  },
})

export const PREF_LIMITS = Object.freeze({
  deadzone: [0.08, 0.7, 0.01],
  repeatDelay: [150, 1200, 10],
  repeatInterval: [40, 500, 10],
})

export const KEYBOARD_LAYOUTS = Object.freeze({
  letters: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '/', ':'],
  ],
  symbols: [
    ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
    ['_', '+', '=', '[', ']', '{', '}', ';', "'", '"'],
    ['<', '>', ',', '?', '\\', '|', '~', '`', ' ', '*'],
  ],
})

export const KEYBOARD_ACTIONS = Object.freeze([
  { id: 'space', label: '空格' },
  { id: 'backspace', label: '退格' },
  { id: 'clear', label: '清空' },
  { id: 'layout', label: '符号' },
  { id: 'shift', label: '大写' },
  { id: 'done', label: '完成' },
  { id: 'cancel', label: '取消' },
])

export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min))

/** 把任意来源的偏好值收敛到合法范围，避免坏 localStorage 数据破坏轮询 */
export function normalizePrefs(input) {
  const source = input && typeof input === 'object' ? input : {}
  const prefs = { ...DEFAULT_PREFS, map: { ...DEFAULT_MAP } }
  if (typeof source.enabled === 'boolean') prefs.enabled = source.enabled
  if (typeof source.vibration === 'boolean') prefs.vibration = source.vibration
  if (typeof source.hintBar === 'boolean') prefs.hintBar = source.hintBar
  if (typeof source.hideCursor === 'boolean') prefs.hideCursor = source.hideCursor
  if (typeof source.invertY === 'boolean') prefs.invertY = source.invertY
  prefs.stick = source.stick === 'right' ? 'right' : 'left'
  prefs.deadzone = clamp(source.deadzone ?? DEFAULT_PREFS.deadzone, ...PREF_LIMITS.deadzone)
  prefs.repeatDelay = clamp(source.repeatDelay ?? DEFAULT_PREFS.repeatDelay, ...PREF_LIMITS.repeatDelay)
  prefs.repeatInterval = clamp(source.repeatInterval ?? DEFAULT_PREFS.repeatInterval, ...PREF_LIMITS.repeatInterval)
  if (source.map && typeof source.map === 'object') {
    for (const [action, button] of Object.entries(source.map)) {
      const index = Number(button)
      if (Object.values(ACTION).includes(action) && Number.isInteger(index) && index >= 0 && index < BUTTON_LABELS.length) {
        prefs.map[action] = index
      }
    }
  }
  return prefs
}
