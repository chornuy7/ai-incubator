import { useMemo, useState } from 'react'
import { GraduationCap, Search, ChevronRight } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { HELP_DOCS, type HelpDoc } from '@/shared/config/helpDocs'
import { cn } from '@/shared/lib/utils'

/**
 * §10.7: страница «Обучение» — вся информация по работе в одном месте.
 *
 * Собирается ИЗ доков Help Center (HELP_DOCS) — тех же, что всплывают по «?» на
 * страницах. Один источник правды: добавили/поменяли описание модуля в helpDocs —
 * оно тут же в обучении, руками ничего не дублируется (созвон 27.07: «дока модуля
 * собирается из описаний блоков»).
 *
 * Группы — чтобы длинный список читался: модули, парсеры, правила, доступы.
 */
const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Модули', keys: ['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-react', 'mass-looking', 'warming', 'autoposting', 'mailing-rules', 'ggr', 'channel-rating'] },
  { title: 'Парсеры', keys: ['parsing', 'parsing-groups', 'parsing-users', 'parsing-messages', 'parsing-comments'] },
  { title: 'Безопасность и правила', keys: ['safety-limits', 'trust-autostop', 'warming-policy', 'captcha-antispam', 'proxy-policy'] },
  { title: 'Доступы и разделы', keys: ['rbac-roles', 'accounts-manager', 'automation', 'goals', 'campaign', 'crm', 'analytics', 'logs'] },
]

export function LearningPage() {
  const [q, setQ] = useState('')
  const [active, setActive] = useState<string | null>(null)

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((g) => ({
    ...g,
    items: g.keys
      .map((k) => ({ key: k, doc: HELP_DOCS[k] }))
      .filter((x): x is { key: string; doc: HelpDoc } => !!x.doc)
      .filter((x) => !needle || `${x.doc.title} ${x.doc.what}`.toLowerCase().includes(needle)),
  })).filter((g) => g.items.length), [needle])

  const activeDoc = active ? HELP_DOCS[active] : null

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<GraduationCap size={20} />}
        title="Обучение"
        subtitle="Как устроена платформа и каждый модуль — вся справка в одном месте. Обновляется автоматически из Help Center."
      />

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="p-3">
          <div className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по темам…" className="input h-9 w-full pl-9 text-sm" />
          </div>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {groups.map((g) => (
              <div key={g.title}>
                <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-muted">{g.title}</div>
                {g.items.map((x) => (
                  <button
                    key={x.key}
                    onClick={() => setActive(x.key)}
                    className={cn('flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                      active === x.key ? 'bg-spark-500/12 text-spark-200' : 'text-muted hover:bg-white/[.03] hover:text-fg')}
                  >
                    <ChevronRight size={13} className="shrink-0 opacity-60" /> {x.doc.title}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <div className="px-2 py-4 text-sm text-muted">Ничего не найдено.</div>}
          </div>
        </Card>

        <Card className="p-5">
          {!activeDoc ? (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-muted">
              <GraduationCap size={32} className="mb-3 opacity-40" />
              <div className="text-sm">Выберите тему слева — откроется подробное объяснение:<br />что это, как работает, риски и пример.</div>
            </div>
          ) : (
            <article className="space-y-5">
              <h2 className="font-display text-2xl font-bold text-fg">{activeDoc.title}</h2>
              <Section title="Что это" body={activeDoc.what} />
              <Section title="Как работает внутри" body={activeDoc.how} />
              <Section title="Вместе с остальными" body={activeDoc.together} />
              <Section title="Пример" body={activeDoc.example} accent />
              {activeDoc.risks && <Section title="Риски и безопасность" body={activeDoc.risks} warn />}
              {activeDoc.tips?.length ? (
                <div>
                  <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">Советы</div>
                  <ul className="space-y-1">
                    {activeDoc.tips.map((t, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted"><span className="text-spark-400">•</span> {t}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          )}
        </Card>
      </div>
    </div>
  )
}

function Section({ title, body, accent, warn }: { title: string; body: string; accent?: boolean; warn?: boolean }) {
  return (
    <div>
      <div className={cn('mb-1.5 text-xs font-bold uppercase tracking-wide', warn ? 'text-amber-300' : 'text-muted')}>{title}</div>
      <p className={cn('whitespace-pre-wrap text-sm leading-relaxed',
        accent ? 'rounded-xl border border-spark-500/25 bg-spark-500/6 p-3 text-fg' : warn ? 'text-amber-100/80' : 'text-muted')}>{body}</p>
    </div>
  )
}
