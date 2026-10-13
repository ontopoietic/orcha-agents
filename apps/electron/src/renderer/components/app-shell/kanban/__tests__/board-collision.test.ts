import { describe, it, expect } from 'bun:test'
import type { ClientRect, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core'
import { areColumnsStacked, boardCollisionDetection } from '../board-collision'

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

function detect(columns: Record<string, ClientRect>, dragged: ClientRect, pointer: { x: number; y: number }) {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>(Object.entries(columns))
  const droppableContainers = Object.keys(columns).map(id => ({ id, disabled: false, data: { current: undefined } }) as unknown as DroppableContainer)
  const collisions = boardCollisionDetection({
    active: { id: 'card', data: { current: undefined }, rect: { current: { initial: dragged, translated: dragged } } },
    collisionRect: dragged,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as Parameters<typeof boardCollisionDetection>[0])
  return collisions[0]?.id
}

describe('areColumnsStacked', () => {
  it('is false for side-by-side columns and a single column', () => {
    expect(areColumnsStacked([rect(16, 0, 260, 600), rect(288, 0, 260, 600)])).toBe(false)
    expect(areColumnsStacked([rect(16, 0, 260, 600)])).toBe(false)
  })
  it('is true when every column shares a left edge', () => {
    expect(areColumnsStacked([rect(12, 0, 396, 420), rect(12, 432, 396, 60), rect(12.3, 504, 396, 60)])).toBe(true)
  })
})

describe('boardCollisionDetection', () => {
  // Compact stack: a tall To Do (5 cards) above two short, empty columns.
  const stacked = {
    todo: rect(12, 0, 396, 420),
    progress: rect(12, 432, 396, 60),
    done: rect(12, 504, 396, 60),
  }

  it('keeps a card held inside a tall stacked column in that column', () => {
    // Card dragged near the bottom of To Do: its corners are closer to the empty In Progress lane.
    const dragged = rect(20, 340, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 380 })).toBe('todo')
  })

  it('drops into the stacked column under the pointer', () => {
    const dragged = rect(20, 420, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 460 })).toBe('progress')
  })

  it('falls back to the closest column in the gap between stacked columns', () => {
    const dragged = rect(20, 400, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 426 })).toBeDefined()
  })

  it('leaves side-by-side targeting to closestCorners', () => {
    const wide = { todo: rect(16, 0, 260, 600), progress: rect(288, 0, 260, 600) }
    const dragged = rect(300, 100, 240, 72)
    expect(detect(wide, dragged, { x: 420, y: 130 })).toBe('progress')
  })
})
