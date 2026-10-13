import { describe, expect, it } from 'bun:test'
import { headerLabelFitCount, labelStripBudget, visibleLabelIndexes } from '../label-strip-layout'

describe('chat header label strip budget', () => {
  it('takes a capped share of the title row', () => {
    expect(labelStripBudget(1000)).toBe(360)
    expect(labelStripBudget(400)).toBe(180)
  })
  it('never squeezes the title below its reserve', () => {
    expect(labelStripBudget(200)).toBe(40)
    expect(labelStripBudget(100)).toBe(0)
  })
})

describe('chat header label fit', () => {
  it('shows every chip without a counter when up to three fit', () => {
    expect(headerLabelFitCount([50, 40, 30], 200, 24)).toBe(3)
  })
  it('falls back to whole chips plus "+N" when they do not fit', () => {
    expect(headerLabelFitCount([50, 40, 30], 127, 24)).toBe(2)
  })
  it('caps at three chips and always reserves the counter past the cap', () => {
    expect(headerLabelFitCount([50, 40, 30, 20], 1000, 24)).toBe(3)
    expect(headerLabelFitCount([50, 40, 30, 20], 130, 24)).toBe(2)
  })
  it('shows only the counter when the first chip is too wide', () => {
    expect(headerLabelFitCount([140, 20, 20, 20], 100, 24)).toBe(0)
  })
})

describe('chat header visible chips', () => {
  it('shows the leading chips in label order', () => {
    expect(visibleLabelIndexes(5, 2)).toEqual([0, 1])
    expect(visibleLabelIndexes(2, 3)).toEqual([0, 1])
  })
  it('keeps a chip with an open value editor visible in the last slot', () => {
    expect(visibleLabelIndexes(5, 2, 4)).toEqual([0, 4])
    expect(visibleLabelIndexes(5, 2, 1)).toEqual([0, 1])
    expect(visibleLabelIndexes(5, 0, 3)).toEqual([3])
  })
  it('ignores a pinned index outside the list', () => {
    expect(visibleLabelIndexes(5, 2, 7)).toEqual([0, 1])
  })
})
