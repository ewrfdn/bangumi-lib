/**
 * 空间导航的纯函数核心：摇杆 → 方向，方向 → 候选元素打分。
 * 不依赖 DOM，便于单元测试。
 */
import { ACTION, DIRECTION_ACTIONS } from './constants.js'

export function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function intervalOverlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
}

/** 两个矩形在指定轴上的重叠比例（0~1） */
export function overlapRatio(a, b, axis) {
  if (axis === 'y') {
    return intervalOverlap(a.top, a.bottom, b.top, b.bottom) / Math.max(1, Math.min(a.height, b.height))
  }
  return intervalOverlap(a.left, a.right, b.left, b.right) / Math.max(1, Math.min(a.width, b.width))
}

/** 沿移动方向上两个矩形之间的空隙（重叠时为 0） */
export function directionalGap(current, candidate, direction) {
  if (direction === ACTION.RIGHT || direction === 'right') return Math.max(0, candidate.left - current.right)
  if (direction === ACTION.LEFT || direction === 'left') return Math.max(0, current.left - candidate.right)
  if (direction === ACTION.DOWN || direction === 'down') return Math.max(0, candidate.top - current.bottom)
  return Math.max(0, current.bottom - candidate.top)
}

/**
 * 从摇杆轴值得到归一化输入。
 * @param {number[]} axes
 * @param {{deadzone?:number, invertY?:boolean, stick?:'left'|'right'}} prefs
 * @returns {{x:number,y:number}|null}
 */
export function directionFromStick(axes, prefs = {}) {
  if (!axes || axes.length < 2) return null
  const offset = prefs.stick === 'right' ? 2 : 0
  const rawX = Number(axes[offset]) || 0
  const rawY = Number(axes[offset + 1]) || 0
  const deadzone = Number.isFinite(prefs.deadzone) ? prefs.deadzone : 0.28
  const x = Math.abs(rawX) > deadzone ? rawX : 0
  const y = Math.abs(rawY) > deadzone ? rawY : 0
  if (!x && !y) return null
  return { x, y: prefs.invertY ? -y : y }
}

/**
 * 摇杆的播报方向：取幅度更大的轴；previous 用于斜向抖动抑制。
 * @returns {'up'|'down'|'left'|'right'|null}
 */
export function stickDirection(axes, prefs = {}, previous = null) {
  const stick = directionFromStick(axes, prefs)
  if (!stick) return null
  let sx = Math.abs(stick.x)
  let sy = Math.abs(stick.y)
  if (previous === 'left' || previous === 'right') sx += 0.08
  if (previous === 'up' || previous === 'down') sy += 0.08
  if (sx >= sy) return stick.x > 0 ? 'right' : 'left'
  return stick.y > 0 ? 'down' : 'up'
}

/**
 * 在候选元素中挑出指定方向最合理的一个。
 * 打分 = 主轴空隙 + 主轴距离*0.9 + 垂直偏移*2.4 - 正交重叠奖励(≤120px)。
 * 网格布局会优先停在同一列/同一行；同分时优先重叠更多、距离更近、DOM 顺序更靠前。
 *
 * @param {{left:number,top:number,right:number,bottom:number,width:number,height:number}} currentRect
 * @param {{rect:object, order?:number}[]} candidates
 * @param {'up'|'down'|'left'|'right'} direction
 */
export function pickDirection(currentRect, candidates, direction) {
  if (!currentRect || !candidates?.length) return null
  const cur = centerOf(currentRect)
  const horizontal = direction === 'left' || direction === 'right'
  let best = null
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const rect = candidate?.rect
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue
    const center = centerOf(rect)
    const dx = center.x - cur.x
    const dy = center.y - cur.y
    const ahead =
      direction === 'right' ? dx > 1
        : direction === 'left' ? dx < -1
          : direction === 'down' ? dy > 1
            : dy < -1
    if (!ahead) continue
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy)
    const secondary = horizontal ? Math.abs(dy) : Math.abs(dx)
    const gap = directionalGap(currentRect, rect, direction)
    const overlap = overlapRatio(currentRect, rect, horizontal ? 'y' : 'x')
    const score = gap + primary * 0.9 + secondary * 2.4 - overlap * Math.min(primary, 120)
    const order = candidate.order ?? index
    const entry = { candidate, score, overlap, distance: primary + secondary, order }
    if (!best) { best = entry; continue }
    if (score < best.score - 0.01) best = entry
    else if (Math.abs(score - best.score) <= 0.01) {
      if (overlap > best.overlap + 0.01) best = entry
      else if (Math.abs(overlap - best.overlap) <= 0.01 && (entry.distance < best.distance - 0.01 || (Math.abs(entry.distance - best.distance) <= 0.01 && order < best.order))) {
        best = entry
      }
    }
  }
  return best ? best.candidate : null
}

/**
 * 方向键连发状态机：第一次按下立即触发，长按 delay 后每隔 interval 触发一次。
 * 返回 update(pressedActions, now, { delay, interval }) => [{ action, repeat }]
 */
export function createRepeatTracker() {
  const held = new Map()
  return {
    update(pressedActions, now, timing = {}) {
      const delay = Number.isFinite(timing.delay) ? timing.delay : 420
      const interval = Number.isFinite(timing.interval) ? timing.interval : 120
      const fired = []
      const next = new Map()
      for (const action of DIRECTION_ACTIONS) {
        const pressed = typeof pressedActions?.has === 'function' ? pressedActions.has(action) : Boolean(pressedActions?.[action])
        if (!pressed) continue
        const nextAt = held.get(action)
        if (nextAt === undefined) {
          fired.push({ action, repeat: false })
          next.set(action, now + delay)
        } else if (now >= nextAt) {
          fired.push({ action, repeat: true })
          next.set(action, now + interval)
        } else {
          next.set(action, nextAt)
        }
      }
      held.clear()
      for (const [action, value] of next) held.set(action, value)
      return fired
    },
    reset() { held.clear() },
  }
}
