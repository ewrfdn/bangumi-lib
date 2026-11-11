import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION, BUTTON, BUTTON_LABELS, DEFAULT_MAP, DEFAULT_PREFS, HINT_ORDER, normalizePrefs } from '../src/gamepad/constants.js'
import { createRepeatTracker, directionFromStick, overlapRatio, pickDirection, stickDirection } from '../src/gamepad/spatial.js'

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })

/* 3 列 2 行海报墙，卡片 125×230，列间距 12，行间距 22 */
const card = (column, row) => rect(column * 137, row * 252, 125, 230)

test('normalizePrefs 收敛非法偏好并保留合法映射', () => {
  const defaults = normalizePrefs(null)
  assert.equal(defaults.deadzone, DEFAULT_PREFS.deadzone)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.stick, 'left')
  assert.deepEqual(defaults.map, { ...DEFAULT_MAP })

  const clamped = normalizePrefs({ deadzone: 9, repeatDelay: 5, repeatInterval: 9999, stick: 'both', invertY: 1 })
  assert.equal(clamped.deadzone, 0.7)
  assert.equal(clamped.repeatDelay, 150)
  assert.equal(clamped.repeatInterval, 500)
  assert.equal(clamped.stick, 'left')
  assert.equal(clamped.invertY, false)

  const mapped = normalizePrefs({ map: { confirm: 1, back: 99, nope: 2 } })
  assert.equal(mapped.map.confirm, 1)
  assert.equal(mapped.map.back, DEFAULT_MAP.back)
  assert.equal('nope' in mapped.map, false)

  const broken = normalizePrefs({ deadzone: 'abc' })
  assert.equal(broken.deadzone, 0.08)
})

test('截图键默认映射到全屏动作，且允许改键', () => {
  assert.equal(BUTTON.SHARE, 17)
  assert.equal(BUTTON_LABELS[17], '截图')
  assert.equal(DEFAULT_MAP[ACTION.FULLSCREEN], BUTTON.SHARE)
  assert.ok(HINT_ORDER.includes(ACTION.FULLSCREEN), '提示条会展示全屏动作')

  assert.equal(normalizePrefs({ map: { fullscreen: 1 } }).map[ACTION.FULLSCREEN], 1, '可以把全屏改到其他按键')
  assert.equal(normalizePrefs({ map: { fullscreen: 18 } }).map[ACTION.FULLSCREEN], BUTTON.SHARE, '越界按键回退默认')
  assert.equal(normalizePrefs({}).map[ACTION.FULLSCREEN], BUTTON.SHARE, '旧存档缺少该字段时补默认值')
})

test('directionFromStick 处理死区、反转与左右摇杆', () => {
  assert.equal(directionFromStick([0.1, -0.2], { deadzone: 0.28 }), null)
  assert.deepEqual(directionFromStick([0.5, -0.2], { deadzone: 0.28 }), { x: 0.5, y: 0 })
  assert.deepEqual(directionFromStick([0, 0.8], { deadzone: 0.28, invertY: true }), { x: 0, y: -0.8 })
  assert.deepEqual(directionFromStick([0, 0, 0.9, 0.1], { deadzone: 0.28, stick: 'right' }), { x: 0.9, y: 0 })
  assert.equal(directionFromStick([0.9], { deadzone: 0.28 }), null)
  assert.equal(directionFromStick(null, {}), null)
})

test('stickDirection 选主导轴并抑制斜向抖动', () => {
  assert.equal(stickDirection([0.9, 0.1], {}), 'right')
  assert.equal(stickDirection([-0.9, 0.2], {}), 'left')
  assert.equal(stickDirection([0.1, 0.9], {}), 'down')
  assert.equal(stickDirection([0.2, -0.9], {}), 'up')
  assert.equal(stickDirection([0.1, 0.1], {}), null)
  assert.equal(stickDirection([-0.42, 0.45], {}), 'down')
  assert.equal(stickDirection([-0.42, 0.45], {}, 'left'), 'left')
})

test('pickDirection 在网格中沿同排/同列移动', () => {
  const current = card(0, 0)
  const candidates = [
    { rect: card(1, 0), order: 0 },
    { rect: card(2, 0), order: 1 },
    { rect: card(0, 1), order: 2 },
    { rect: card(1, 1), order: 3 },
  ]
  assert.equal(pickDirection(current, candidates, ACTION.RIGHT).order, 0)
  assert.equal(pickDirection(current, candidates, ACTION.DOWN).order, 2)
  assert.equal(pickDirection(current, candidates, ACTION.LEFT), null)
  assert.equal(pickDirection(current, candidates, ACTION.UP), null)

  const middle = card(1, 0)
  assert.equal(pickDirection(middle, [{ rect: card(2, 1), order: 0 }, { rect: card(2, 0), order: 1 }], ACTION.RIGHT).order, 1)
  assert.equal(pickDirection(middle, [{ rect: card(0, 1), order: 0 }, { rect: card(1, 1), order: 1 }], ACTION.DOWN).order, 1)
})

test('pickDirection 优先选择与当前元素对齐的候选', () => {
  const current = rect(100, 100, 100, 100)
  const aligned = { rect: rect(100, 260, 100, 60), order: 0 } // 正下方，但更远
  const offset = { rect: rect(300, 230, 100, 60), order: 1 } // 更近，但明显偏右
  assert.equal(pickDirection(current, [aligned, offset], ACTION.DOWN).order, 0)
})

test('pickDirection 跳过不可见候选并按 DOM 顺序兜底', () => {
  const current = rect(0, 0, 100, 100)
  const candidates = [
    { rect: rect(0, 0, 0, 0), order: 0 },
    { rect: rect(200, 0, 100, 100), order: 1 },
    { rect: rect(200, 0, 100, 100), order: 2 },
  ]
  assert.equal(pickDirection(current, candidates, ACTION.RIGHT).order, 1)
  assert.equal(overlapRatio(rect(0, 0, 100, 100), rect(0, 50, 100, 100), 'y'), 0.5)
  assert.equal(overlapRatio(rect(0, 0, 100, 100), rect(300, 0, 100, 100), 'x'), 0)
})

test('createRepeatTracker 首次立即触发、长按按延迟与间隔连发', () => {
  const tracker = createRepeatTracker()
  const timing = { delay: 400, interval: 100 }
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 0, timing), [{ action: ACTION.RIGHT, repeat: false }])
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 200, timing), [])
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 400, timing), [{ action: ACTION.RIGHT, repeat: true }])
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 450, timing), [])
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 500, timing), [{ action: ACTION.RIGHT, repeat: true }])
  assert.deepEqual(tracker.update(new Set(), 520, timing), [])
  assert.deepEqual(tracker.update(new Set([ACTION.RIGHT]), 600, timing), [{ action: ACTION.RIGHT, repeat: false }])
})

test('createRepeatTracker 同时支持对角双方向', () => {
  const tracker = createRepeatTracker()
  const fired = tracker.update(new Set([ACTION.LEFT, ACTION.UP]), 0, { delay: 400, interval: 100 })
  assert.deepEqual(fired.map((item) => item.action), [ACTION.UP, ACTION.LEFT])
})

test('偏好读写持久化、损坏数据回退默认值', async () => {
  const storage = new Map()
  globalThis.window = {
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, value) },
    isSecureContext: true,
  }
  const store = await import('../src/gamepad/store.js')
  store.savePrefs({ deadzone: 0.5, map: { confirm: 1 } })
  assert.equal(store.gamepad.prefs.deadzone, 0.5)
  assert.equal(store.gamepad.prefs.map.confirm, 1)
  assert.ok(storage.get('anishare.gamepad.v1').includes('0.5'))

  storage.set('anishare.gamepad.v1', '{"deadzone":0.4,"enabled":false,"stick":"right"}')
  store.loadPrefs()
  assert.equal(store.gamepad.prefs.deadzone, 0.4)
  assert.equal(store.gamepad.prefs.enabled, false)
  assert.equal(store.gamepad.prefs.stick, 'right')

  storage.set('anishare.gamepad.v1', '{broken json')
  store.loadPrefs()
  assert.equal(store.gamepad.prefs.deadzone, 0.28)

  store.resetPrefs()
  assert.equal(store.gamepad.prefs.deadzone, 0.28)
  assert.equal(store.gamepad.prefs.map.confirm, 0)
})

test('B 返回在四个主页面禁用、只在子页面生效', async () => {
  // 放在 store 测试之后 import：store.js 在导入时缓存 window 是否存在
  const { backDisabledOn } = await import('../src/gamepad/dispatch.js')
  assert.equal(backDisabledOn({ name: 'home' }), true)
  assert.equal(backDisabledOn({ name: 'library', query: { library: 'bangumi' } }), true)
  assert.equal(backDisabledOn({ name: 'admin' }), true)
  assert.equal(backDisabledOn({ name: 'browse', query: {} }), true, '文件浏览根目录算主页面')
  assert.equal(backDisabledOn({ name: 'browse', query: { path: '/' } }), true)
  assert.equal(backDisabledOn({ name: 'browse', query: { path: '合集/第一季' } }), false, '进入子文件夹后允许返回')
  assert.equal(backDisabledOn({ name: 'series', query: { path: '合集/第一季' } }), false, '作品详情是子页面')
  assert.equal(backDisabledOn({ name: 'watch' }), false, '播放器是子页面')
  assert.equal(backDisabledOn({ name: 'login' }), false)
  assert.equal(backDisabledOn(null), false)
})

test('上下文注册合并提示、keepFocusless 只在页面上下文生效', async () => {
  const dispatch = await import('../src/gamepad/dispatch.js')
  const store = await import('../src/gamepad/store.js')
  const page = dispatch.registerGamepadContext({ id: 'page', hints: { confirm: '页面选择' }, handle: () => false })
  assert.equal(store.gamepad.hints.confirm, '页面选择')
  assert.equal(dispatch.shouldSuppressAutoFocus(), false)

  const player = dispatch.registerGamepadContext({ id: 'player', keepFocusless: true, handle: () => false })
  assert.equal(dispatch.shouldSuppressAutoFocus(), true)

  const overlay = dispatch.registerGamepadContext({ id: 'overlay', overlay: true, hints: { 'prev-tab': '上一页签' }, handle: () => false })
  // 浮层上下文不应影响页面自动聚焦判断
  assert.equal(dispatch.shouldSuppressAutoFocus(), true)
  assert.equal(store.gamepad.hints['prev-tab'], '上一页签')

  overlay()
  player()
  page()
  assert.equal(dispatch.shouldSuppressAutoFocus(), false)
  assert.equal(store.gamepad.hints.confirm, '选择')
})
