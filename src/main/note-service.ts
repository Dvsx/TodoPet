import { randomUUID } from 'node:crypto'
import { getSqlite } from './database.js'
import type { Note, NoteInput, NoteKind } from '../shared/types.js'

type NoteRow = { id: string; kind: NoteKind; title: string; body: string; created_at: string; updated_at: string }

const toNote = (row: NoteRow): Note => ({
  id: row.id, kind: row.kind, title: row.title, body: row.body,
  createdAt: row.created_at, updatedAt: row.updated_at
})

export class NoteService {
  list(kind: NoteKind): Note[] {
    const rows = getSqlite().prepare('SELECT * FROM notes WHERE kind=? ORDER BY created_at DESC').all(kind) as NoteRow[]
    return rows.map(toNote)
  }

  get(id: string): Note | null {
    const row = getSqlite().prepare('SELECT * FROM notes WHERE id=?').get(id) as NoteRow | undefined
    return row ? toNote(row) : null
  }

  create(kind: NoteKind, input: NoteInput): Note {
    const now = new Date().toISOString()
    const id = randomUUID()
    getSqlite().prepare('INSERT INTO notes (id,kind,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(
      id, kind, input.title.trim(), input.body?.trim() ?? '', now, now
    )
    return this.get(id)!
  }

  update(id: string, input: Partial<NoteInput>): Note {
    const existing = this.get(id)
    if (!existing) throw new Error('笔记不存在')
    const now = new Date().toISOString()
    getSqlite().prepare('UPDATE notes SET title=?, body=?, updated_at=? WHERE id=?').run(
      input.title === undefined ? existing.title : input.title.trim(),
      input.body === undefined ? existing.body : input.body.trim(),
      now, id
    )
    return this.get(id)!
  }

  remove(id: string): Note {
    const existing = this.get(id)
    if (!existing) throw new Error('笔记不存在')
    getSqlite().prepare('DELETE FROM notes WHERE id=?').run(id)
    return existing
  }
}
