export function dayKeyOf(iso: string) {
  const date = new Date(iso)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function headingOf(key: string, now = new Date()) {
  const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  const yesterday = `${yest.getFullYear()}-${yest.getMonth()}-${yest.getDate()}`
  const tom = new Date(now)
  tom.setDate(now.getDate() + 1)
  const tomorrow = `${tom.getFullYear()}-${tom.getMonth()}-${tom.getDate()}`
  const [year, month, day] = key.split('-').map(Number)
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(year, month, day))
  if (key === today) return `今天 · ${weekday}`
  if (key === yesterday) return `昨天 · ${weekday}`
  if (key === tomorrow) return `明天 · ${weekday}`
  if (year === now.getFullYear()) return `${month + 1}月${day}日 · ${weekday}`
  return `${year}年${month + 1}月${day}日 · ${weekday}`
}

export function groupByDay<T>(items: T[], isoOf: (item: T) => string) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = dayKeyOf(isoOf(item))
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return [...map.entries()]
    .sort((left, right) => {
      const [ly, lm, ld] = left[0].split('-').map(Number)
      const [ry, rm, rd] = right[0].split('-').map(Number)
      return new Date(ry, rm, rd).getTime() - new Date(ly, lm, ld).getTime()
    })
    .map(([key, grouped]) => ({ key, label: headingOf(key), items: grouped }))
}
