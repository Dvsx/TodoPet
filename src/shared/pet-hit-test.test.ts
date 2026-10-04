import {describe, it, expect} from 'vitest'
import {hangOverlayBounds, isUsablePetShapeBounds, petWindowShape, petSpriteSize, SHAKE_PAD} from './hang-pet'
describe('native pet region', () => {
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
