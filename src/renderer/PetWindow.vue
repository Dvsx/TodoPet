<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { parsePetManifest } from '../shared/codex-pet'
import { CLIMB_MS, DROP_MS, HEALTH_TOAST_MS, HINT_FADE_MS, PIXEL_TOAST_WIDTH, SHAKE_MS, SHAKE_PAD, petSpriteSize } from '../shared/hang-pet'
import { isHealthDrop } from '../shared/pet-reactions'
import { canContinueHealthPlayback, isExpiredHealthEvent, queuePetEvent, takeNextPetEvent } from '../shared/pet-event-queue'
import type { PetEvent } from '../shared/types'

const PET_ID = 'spidey'
const reducedMotion = ref(false)
const message = ref('')
const autoResumeId = ref<string|null>(null)
const correcting = ref(false)
const hintVisible = ref(false)
const shaking = ref(false)
const dropped = ref(false)
const sliding = ref(false)
const busy = ref(false)
const sprite = ref(petSpriteSize('medium'))
const cutoutUrl = ref(`${import.meta.env.BASE_URL}pets/${PET_ID}/spidey-hanging-cutout.png`)
const displayName = ref('Spidey')

let hintTimer: ReturnType<typeof setTimeout> | null = null
let hintClearTimer: ReturnType<typeof setTimeout> | null = null
let dragFrame: number | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeReset: (() => void) | null = null
let sequence = 0
let hanging = false
let currentHealth: PetEvent | null = null
let drag: { x: number; y: number; latestX: number; latestY: number; pointerId: number; target: HTMLElement } | null = null
const queued: PetEvent[] = []

const actorStyle = computed(() => ({
  '--sprite-w': `${sprite.value.width}px`,
  '--sprite-h': `${sprite.value.height}px`,
  '--shake-pad': `${SHAKE_PAD}px`,
  '--toast-max-w': `${PIXEL_TOAST_WIDTH}px`
}))

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer)
  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hideMessage(): void {
  hintTimer = clearTimer(hintTimer)
  hintClearTimer = clearTimer(hintClearTimer)
  autoResumeId.value = null
  hintVisible.value = false
  hintClearTimer = setTimeout(() => {
    message.value = ''
    void window.todoPet?.pet.setToastVisible(false)
  }, reducedMotion.value ? 0 : HINT_FADE_MS)
}

function showMessage(text: string, holdMs = 3000, autoHide = true): void {
  hintTimer = clearTimer(hintTimer)
  hintClearTimer = clearTimer(hintClearTimer)
  if (!text) {
    hideMessage()
    return
  }
  message.value = text
  hintVisible.value = true
  void window.todoPet?.pet.setToastVisible(true)
  if (autoHide) {
    hintTimer = setTimeout(() => {
      hideMessage()
    }, holdMs)
  }
}

function onSpritePointerDown(event: PointerEvent): void {
  if (busy.value || event.button !== 0) return
  const x = Math.round(event.screenX)
  const y = Math.round(event.screenY)
  cancelDrag()
  drag = { x, y, latestX: x, latestY: y, pointerId: event.pointerId, target: event.currentTarget as HTMLElement }
  window.addEventListener('pointermove', onSpritePointerMove)
  window.addEventListener('pointerup', onSpritePointerUp)
  window.addEventListener('pointercancel', onDragInterrupted)
  try { drag.target.setPointerCapture(event.pointerId) } catch { /* overlay never takes focus */ }
  event.preventDefault()
}

function flushDragMove(): void {
  dragFrame = null
  if (!drag) return
  const dx = drag.latestX - drag.x
  const dy = drag.latestY - drag.y
  if (!dx && !dy) return
  drag.x = drag.latestX
  drag.y = drag.latestY
  window.todoPet?.pet.nudge({ dx, dy })
}

function onSpritePointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  drag.latestX = Math.round(event.screenX)
  drag.latestY = Math.round(event.screenY)
  if (dragFrame === null) dragFrame = window.requestAnimationFrame(flushDragMove)
}

function unbindDragListeners(): void {
  window.removeEventListener('pointermove', onSpritePointerMove)
  window.removeEventListener('pointerup', onSpritePointerUp)
  window.removeEventListener('pointercancel', onDragInterrupted)
}

function cancelDrag(flush = false): void {
  if (!drag) {
    unbindDragListeners()
    return
  }
  if (dragFrame !== null) window.cancelAnimationFrame(dragFrame)
  dragFrame = null
  if (flush) flushDragMove()
  const finished = drag
  drag = null
  unbindDragListeners()
  if (finished.target.hasPointerCapture(finished.pointerId)) finished.target.releasePointerCapture(finished.pointerId)
  window.todoPet?.pet.endDrag()
}
function onSpritePointerUp(event: PointerEvent): void {
  if (drag && event.pointerId !== drag.pointerId) return
  cancelDrag(true)
}
function onDragInterrupted(): void { cancelDrag() }
function resetIdle(): void {
  const needsHangReset = hanging || busy.value || shaking.value || dropped.value || sliding.value
  sequence += 1
  hanging = false
  currentHealth = null
  busy.value = false
  shaking.value = false
  dropped.value = false
  sliding.value = false
  queued.length = 0
  cancelDrag()
  hideMessage()
  if (needsHangReset) void window.todoPet?.pet.setHangMode('perch')
}
function onVisibilityChange(): void {
  if (document.hidden) resetIdle()
  else cancelDrag()
}

async function setHangMode(mode: 'perch' | 'drop'): Promise<void> {
  await window.todoPet?.pet.setHangMode(mode)
}

async function correctAutoResume(choice:'standing'|'pause') {
  if(!autoResumeId.value || correcting.value)return
  correcting.value=true
  hintTimer=clearTimer(hintTimer)
  try {await window.todoPet.health.correctAutoResume(autoResumeId.value,choice);autoResumeId.value=null;showMessage(choice==='standing'?'已改为站着记录':'已暂停，手动继续后再记录')}
  catch(e){autoResumeId.value=null;showMessage(String(e))}
  finally{correcting.value=false}
}
function play(event: PetEvent): void {
  if (isHealthDrop(event.action)) {
    if (isExpiredHealthEvent(event)) return
    if (event.reminder && event.reminder.id === currentHealth?.reminder?.id) return
    if (hanging) {
      queuePetEvent(queued, event)
      return
    }
    void runHealth(event)
    return
  }
  if (hanging) {
    queuePetEvent(queued, event)
    return
  }
  autoResumeId.value=event.autoResumeSegmentId ?? null
  showMessage(event.message ?? '',event.autoResumeSegmentId?10000:3000)
}

function flushQueue(): void {
  const next = takeNextPetEvent(queued)
  if (next) play(next)
}

async function runHealth(event: PetEvent): Promise<void> {
  if (isExpiredHealthEvent(event)) return
  const token = ++sequence
  currentHealth = event
  hanging = true
  busy.value = true
  cancelDrag()
  shaking.value = false
  dropped.value = false
  sliding.value = false
  hintTimer = clearTimer(hintTimer)
  hintClearTimer = clearTimer(hintClearTimer)
  hintVisible.value = false
  message.value = ''
  void window.todoPet?.pet.setToastVisible(false)

  if (reducedMotion.value) {
    showMessage(event.message ?? '', HEALTH_TOAST_MS, false)
    await wait(HEALTH_TOAST_MS)
    if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
    hideMessage()
    await wait(HINT_FADE_MS)
    if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
    await finishHealth(event, token)
    return
  }

  await setHangMode('drop')
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  shaking.value = true
  await wait(SHAKE_MS)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  shaking.value = false
  sliding.value = true
  dropped.value = true
  await wait(DROP_MS)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return

  showMessage(event.message ?? '', HEALTH_TOAST_MS, false)
  await wait(HEALTH_TOAST_MS)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  hideMessage()
  await wait(HINT_FADE_MS)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return

  dropped.value = false
  await wait(CLIMB_MS)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  sliding.value = false
  await finishHealth(event, token)
}

async function finishHealth(event: PetEvent, token: number): Promise<void> {
  shaking.value = false
  dropped.value = false
  sliding.value = false
  await setHangMode('perch')
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  await window.todoPet?.pet.finishHang(event.reminder?.id)
  if (!canContinueHealthPlayback(event, token, sequence, resetIdle)) return
  hanging = false
  busy.value = false
  currentHealth = null
  flushQueue()
}

onMounted(() => {
  unsubscribeReset = window.todoPet?.events.onPetReset(resetIdle) ?? null
  window.addEventListener('blur', onDragInterrupted)
  document.addEventListener('visibilitychange', onVisibilityChange)
  unsubscribe = window.todoPet?.events.onPetEvent((event: PetEvent) => play(event)) ?? null
  void boot()
})

async function boot(): Promise<void> {
  const settings = window.todoPet
    ? await window.todoPet.pet.getSettings()
    : { reducedMotion: false, size: 'medium' as const }
  reducedMotion.value = settings.reducedMotion
  sprite.value = petSpriteSize(settings.size)
  const base = import.meta.env.BASE_URL
  try {
    const manifest = parsePetManifest(await (await fetch(`${base}pets/${PET_ID}/pet.json`)).json())
    if (manifest?.displayName) displayName.value = manifest.displayName
    cutoutUrl.value = `${base}pets/${PET_ID}/${manifest?.spritesheetPath ?? 'spidey-hanging-cutout.png'}`
  } catch {
    cutoutUrl.value = `${base}pets/${PET_ID}/spidey-hanging-cutout.png`
  }
  await window.todoPet?.pet.ready()
  const demo = new URLSearchParams(window.location.search).get('demo')
  if (demo === 'created') showMessage('已记录：巡逻')
  if (demo === 'done') showMessage('已完成：巡逻')
  if (demo === 'health') {
    void runHealth({ animation: 'waiting', hold: true, action: 'health-water', message: '喝水时间到了' })
  }
}

onBeforeUnmount(() => {
  resetIdle()
  window.removeEventListener('blur', onDragInterrupted)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  hintTimer = clearTimer(hintTimer)
  hintClearTimer = clearTimer(hintClearTimer)
  if (dragFrame !== null) window.cancelAnimationFrame(dragFrame)
  unsubscribe?.()
  unsubscribeReset?.()
})
</script>
<template>
  <div class="pet-stage" :class="{ reduced: reducedMotion, busy, toast: Boolean(message) }" :style="actorStyle">
    <div class="web-line" :class="{ dropped, sliding }"></div>
    <div class="hang-actor" :class="{ dropped, shaking, sliding }">
      <div class="pet-hint" :class="{ fade: !hintVisible }" v-if="message">{{ message }}<div v-if="autoResumeId" class="auto-resume-actions" @pointerdown.stop><button :disabled="correcting" @click.stop="correctAutoResume('standing')">我在站着</button><button :disabled="correcting" @click.stop="correctAutoResume('pause')">暂不记录</button></div></div>
      <div class="pet-sprite" @pointerdown="onSpritePointerDown">
        <img class="pet-cutout" :src="cutoutUrl" :alt="displayName" draggable="false" />
        <svg class="spider-sense" viewBox="0 0 120 90" aria-hidden="true">
          <g fill="none" stroke-linecap="square" stroke-linejoin="miter">
            <path class="sense-ink" d="M52 48 L40 42 L44 34 L28 24 L32 20 L12 8" />
            <path class="sense-ink" d="M48 56 L36 60 L40 70 L22 74 L18 68 L4 82" />
            <path class="sense-ink" d="M60 62 L56 72 L64 76 L58 88" />
            <path class="sense-ink" d="M72 56 L84 62 L80 70 L102 78" />
            <path class="sense-ink" d="M74 46 L88 40 L84 32 L110 22" />
            <path class="sense-ink" d="M54 40 L46 28 L52 22 L38 8" />
            <path class="sense-core" d="M52 48 L40 42 L44 34 L28 24 L32 20 L12 8" />
            <path class="sense-core" d="M48 56 L36 60 L40 70 L22 74 L18 68 L4 82" />
            <path class="sense-core" d="M60 62 L56 72 L64 76 L58 88" />
            <path class="sense-core" d="M72 56 L84 62 L80 70 L102 78" />
            <path class="sense-core" d="M74 46 L88 40 L84 32 L110 22" />
            <path class="sense-core" d="M54 40 L46 28 L52 22 L38 8" />
            <path class="sense-hot" d="M52 48 L40 42 L44 34 L28 24" />
            <path class="sense-hot" d="M72 56 L84 62 L80 70" />
            <path class="sense-hot" d="M54 40 L46 28 L52 22" />
          </g>
          <g class="sense-sparks" fill="#ffe44a" stroke="#111" stroke-width="1.5">
            <rect x="8" y="6" width="4" height="4" />
            <rect x="2" y="80" width="4" height="4" />
            <rect x="56" y="86" width="3" height="3" />
            <rect x="108" y="20" width="4" height="4" />
            <rect x="100" y="76" width="3" height="3" />
            <rect x="36" y="6" width="3" height="3" />
          </g>
        </svg>
      </div>
    </div>
  </div>
</template>

<style>
.auto-resume-actions{display:flex;gap:8px;margin-top:8px;pointer-events:auto}.auto-resume-actions button{font:inherit;font-size:12px;padding:5px 7px;border:1px solid #17171b;background:#fffbea;border-radius:4px;cursor:pointer}
</style>
