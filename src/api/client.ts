export async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  const ct = res.headers.get('content-type') || ''
  if (text.trimStart().startsWith('<') || (!ct.includes('json') && text && !text.trimStart().startsWith('{'))) {
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      throw new Error('API недоступен — перезапустите npm run dev (нужны web + api на :5173 и :3001)')
    }
    throw new Error(text.slice(0, 160) || `HTTP ${res.status}`)
  }
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Некорректный ответ API (HTTP ${res.status})`)
  }
  if (!res.ok || (data && typeof data === 'object' && 'ok' in data && !(data as { ok?: boolean }).ok)) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  }
  return data as T
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  return parseJson<T>(res)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}
