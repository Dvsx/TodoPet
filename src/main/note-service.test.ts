import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))

import { closeDatabase } from './database.js'
import { NoteService } from './note-service.js'

const roots: string[] = []
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'todopet-notes-')); roots.push(dir); return dir }

afterEach(() => {
  closeDatabase()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('NoteService', () => {
  it('keeps spark and wrap notes isolated', () => {
    state.root = tempRoot()
    const service = new NoteService()
    const spark = service.create('spark', { title: '一个念头' })
    const wrap = service.create('wrap', { title: '今日收工', body: '写完了两件' })
    expect(service.list('spark').map((note) => note.id)).toEqual([spark.id])
    expect(service.list('wrap').map((note) => note.id)).toEqual([wrap.id])
    expect(service.list('spark')[0].body).toBe('')
    expect(service.list('wrap')[0].body).toBe('写完了两件')
  })

  it('updates title and body', () => {
    state.root = tempRoot()
    const service = new NoteService()
    const note = service.create('spark', { title: '草稿' })
    const updated = service.update(note.id, { title: '定稿', body: '先记下来' })
    expect(updated.title).toBe('定稿')
    expect(updated.body).toBe('先记下来')
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(note.createdAt).getTime())
  })

  it('removes a note and rejects a second delete', () => {
    state.root = tempRoot()
    const service = new NoteService()
    const keep = service.create('wrap', { title: '留下' })
    const gone = service.create('wrap', { title: '删掉' })
    expect(service.remove(gone.id).id).toBe(gone.id)
    expect(service.get(gone.id)).toBeNull()
    expect(service.list('wrap').map((note) => note.id)).toEqual([keep.id])
    expect(() => service.remove(gone.id)).toThrow('笔记不存在')
  })
})
