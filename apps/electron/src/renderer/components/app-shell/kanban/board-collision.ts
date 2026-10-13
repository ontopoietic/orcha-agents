import { closestCorners, pointerWithin, type ClientRect, type CollisionDetection } from '@dnd-kit/core'

/** True when every column shares one left edge, i.e. the compact shell stacked them vertically. */
export function areColumnsStacked(rects: Iterable<ClientRect>): boolean {
  const lefts = new Set<number>()
  let count = 0
  for (const rect of rects) {
    lefts.add(Math.round(rect.left))
    count++
  }
  return count > 1 && lefts.size === 1
}

/**
 * Side-by-side columns keep dnd-kit's `closestCorners` (unchanged targeting). When the compact shell
 * stacks the columns, each drop target is only as tall as its cards, so corner distance can pick a short
 * neighbouring column over the one under the finger; there the column under the pointer wins, with
 * `closestCorners` as the fallback for the gaps between columns.
 */
export const boardCollisionDetection: CollisionDetection = args => {
  if (areColumnsStacked(args.droppableRects.values())) {
    const underPointer = pointerWithin(args)
    if (underPointer.length > 0) return underPointer
  }
  return closestCorners(args)
}
