import { flashDuration } from './codex-pet.js'
import type { PetAnimation, PetEvent } from './types.js'

export type PetMatter = NonNullable<PetEvent['action']>

interface ReactionSpec {
  animation: PetAnimation
  hold: boolean
  title: string
  message: (detail?: string) => string
}

export function clipTitle(title?: string, max = 12): string {
  const text = (title ?? '这件事').trim() || '这件事'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const TABLE: Record<PetMatter, ReactionSpec> = {
  boot: { animation: 'waving', hold: false, title: '蜘蛛侠报到', message: () => '' },
  'task-created': { animation: 'waving', hold: false, title: '已记录', message: (title) => `已记录：${clipTitle(title)}` },
  'task-updated': { animation: 'review', hold: false, title: '已更新', message: (title) => `已更新：${clipTitle(title)}` },
  'task-completed': { animation: 'jumping', hold: false, title: '已完成', message: (title) => `已完成：${clipTitle(title)}` },
  'task-due': { animation: 'waiting', hold: true, title: '蜘蛛感应', message: (title) => `感应到了：${clipTitle(title)}` },
  'health-water': { animation: 'waiting', hold: true, title: '喝水时间到了', message: () => '喝水时间到了' },
  'health-stand': { animation: 'waiting', hold: true, title: '站立时间到了', message: () => '站立时间到了' },
  'health-ack': { animation: 'waving', hold: false, title: '收到', message: () => '' },
  'health-duty-start': { animation: 'waving', hold: false, title: '开始记录', message: () => '已开始记录坐姿，记得喝水和活动一下' },
  snoozed: { animation: 'review', hold: false, title: '先挂着', message: () => '十分钟后再来找你。' }
}

export function isHealthDrop(action?: PetEvent['action']): boolean {
  return action === 'health-water' || action === 'health-stand'
}

export function reactionFor(matter: PetMatter, detail?: string): PetEvent {
  const spec = TABLE[matter]
  return {
    animation: spec.animation,
    hold: spec.hold,
    title: spec.title,
    message: spec.message(detail),
    action: matter
  }
}

export function reactionHoldMs(event: PetEvent): number | null {
  if (event.hold || event.animation === 'idle') return null
  return flashDuration(event.animation)
}
