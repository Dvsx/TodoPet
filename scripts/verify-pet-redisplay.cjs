// Verify telemetry captured by actual Windows mouse actions, never Chromium injection.
// First run diagnose-native-drag.cjs (and --packaged), then save the named snapshots.
const fs = require('node:fs'), assert = require('node:assert/strict'), path = require('node:path');
for (const kind of ['source', 'packaged']) {
  const read = name => JSON.parse(fs.readFileSync(path.resolve(`.pet-run/native-${kind}-${name}.json`), 'utf8'));
  const drag = read('drag'), padding = read('padding'), redisplay = read('redisplay'), hidden = read('hidden');
  for (const sample of [drag, redisplay, hidden]) {
    assert.equal(sample.native.ignored, false);
    assert.ok(sample.renderer.events.some(e => e.type === 'pointerdown' && e.buttons === 1));
    assert.ok(sample.renderer.events.some(e => e.type === 'pointerup'));
    assert.ok(sample.native.calls.every(c => c.ignored === false));
    assert.equal(sample.native.bounds.width, 358);
    assert.equal(sample.native.bounds.height, 457);
  }
  assert.notDeepEqual(drag.native.bounds, {x:500,y:280,width:358,height:457});
  assert.notDeepEqual(redisplay.native.bounds, drag.native.bounds);
  assert.notDeepEqual(hidden.native.bounds, redisplay.native.bounds);
  assert.ok(padding.paddingClicks.length > 0, 'transparent padding must reach the underlying app');
  console.log(`PASS ${kind}: Windows drag, redisplay, hide/show, transparent padding`);
}
