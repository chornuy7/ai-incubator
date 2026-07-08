import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

export function AiGenerationNotice() {
  const [ai, setAi] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setAi(Boolean(d?.ai)))
      .catch(() => setAi(false))
  }, [])

  if (ai !== false) return null

  return (
    <div className="flex gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
      <div>
        <p className="font-semibold text-amber-200">AI не подключён — ответы из шаблонов</p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-100/90">
          Добавьте <code className="rounded bg-black/20 px-1">OPENAI_API_KEY=sk-…</code> в файл{' '}
          <code className="rounded bg-black/20 px-1">.env</code> и перезапустите API. Без ключа
          тексты однотипные («Интересный пост…», «Полезно, возьму на заметку»).
        </p>
      </div>
    </div>
  )
}
