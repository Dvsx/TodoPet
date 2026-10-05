import {describe, it, expect} from 'vitest'
import {hangOverlayBounds, isUsablePetShapeBounds, petWindowShape, petSpriteSize, SHAKE_PAD, toastExtra} from './hang-pet'
describe('native pet region', () => {
  it.each(['small', 'medium', 'large'] as const)('lets the visible %s pet reach both work-area edges', size => {
    for (const work of [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: -1920, y: -100, width: 1920, height: 1080 },
      { x: 48, y: 32, width: 1232, height: 688 }
    ]) {
      const sprite = petSpriteSize(size)
      const left = hangOverlayBounds(work, size, { x: work.x - 10000, y: work.y })
      const right = hangOverlayBounds(work, size, { x: work.x + work.width + 10000, y: work.y })
      expect(left.x + toastExtra()).toBe(work.x)
      expect(right.x + toastExtra() + sprite.width).toBe(work.x + work.width)
      expect(right.width).toBe(left.width)
      expect(right.height).toBe(left.height)
      expect(right.x + right.width).toBe(work.x + work.width + SHAKE_PAD)
      expect(petWindowShape(right, size, 'perch', false)).toEqual([{ x: toastExtra(), y: 0, ...sprite }])
      expect(hangOverlayBounds(work, size, { x: right.x + toastExtra(), y: right.y })).toEqual(right)
    }
  })
  it.each(['small','medium','large'] as const)('excludes unused padding at %s size', size => {
    const bounds = hangOverlayBounds({x:-1920,y:-100,width:1920,height:1080}, size)
    const sprite = petSpriteSize(size)
    expect(petWindowShape(bounds,size,'perch',false)).toEqual([{x:194,y:0,...sprite}])
    expect(petWindowShape(bounds,size,'perch',true)).toEqual([{x:0,y:0,width:bounds.width-SHAKE_PAD,height:sprite.height}])
    expect(petWindowShape(bounds,size,'drop',false)).toEqual([{x:0,y:0,width:bounds.width,height:bounds.height}])
  })
  it('rejects collapsed HWND sizes that would install an empty hit target', () => {
    expect(isUsablePetShapeBounds({width:0,height:0})).toBe(false)
    expect(isUsablePetShapeBounds({width:358,height:457})).toBe(true)
  })
})
