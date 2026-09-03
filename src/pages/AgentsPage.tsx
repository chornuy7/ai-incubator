import { useEffect, useRef, useState } from 'react'
import { Bot, Plus, Pencil, Trash2, Copy, X, Upload, Loader2, Link as LinkIcon, FileText, Paperclip } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select } from '@/shared/ui'
import { LANGUAGES } from '@/shared/config/languages'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchAgents, createAgent, updateAgent, deleteAgent,
  fetchAgentKb, createAgentKb, deleteAgentKb, uploadAgentKbFile, addAgentKbLinks, KB_FILE_MAX_BYTES,
  type Agent, type AgentInput, type AgentKbItem,
} from '@/api/agentsApi'

const EMPTY: AgentInput = {
  name: '', toneOfVoice: '', restrictions: '', character: '', language: '',
  audience: '', completionCriteria: '', firstMessage: '',
}

/**
 * «Агенты» — как персона общается ИИ. Отдельно от Цели: цель = ЧТО достичь, агент = КАК.
 * Решающий довод (созвон 22.07): одна кампания, где 500 хвалят и 500 спорят, — это два
 * агента. Значит тон/характер живут отдельной сущностью, а в кампании выбираются, как цель.
 */
export function AgentsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<AgentInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // База знаний агента: факты о продукте, которые уходят в промпт.
  const [kb, setKb] = useState<AgentKbItem[]>([])
  const [kbTitle, setKbTitle] = useState('')
  const [kbContent, setKbContent] = useState('')
  const [kbLinks, setKbLinks] = useState('')
  const [kbBusy, setKbBusy] = useState(false)
  const [kbDrag, setKbDrag] = useState(false)
  const [kbReport, setKbReport] = useState('')
  const kbFileRef = useRef<HTMLInputElement>(null)

  /**
   * Файлы ПАЧКОЙ. Шлём по одному, а не одним запросом: у каждого свой лимит и своя
   * причина отказа, и оператору важно знать, какой именно файл не прошёл.
   */
  const addFiles = async (list: FileList | null) => {
    if (!editingId || !list?.length) return
    const files = [...list]
    setKbBusy(true); setKbReport('')
    let ok = 0
    const bad: string[] = []
    for (const f of files) {
      // Размер проверяем ДО чтения: base64 раздувает файл на треть и пробивает
      // лимит тела запроса раньше, чем сервер успеет ответить внятной ошибкой.
      if (f.size > KB_FILE_MAX_BYTES) { bad.push(`${f.name} — больше 3 МБ`); continue }
      try { await uploadAgentKbFile(editingId, f); ok++ }
      catch (e) { bad.push(`${f.name} — ${e instanceof Error ? e.message : 'не загрузился'}`) }
    }
    setKbReport(`Добавлено файлов: ${ok}${bad.length ? ` · не вышло: ${bad.join('; ')}` : ''}`)
    setKb(await fetchAgentKb(editingId).catch(() => kb))
    setKbBusy(false)
  }

  /** Ссылки пачкой: сервер скачает текст каждой страницы. */
  const addLinks = async () => {
    if (!editingId) return
    const urls = kbLinks.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean)
    if (!urls.length) return
    setKbBusy(true); setKbReport('')
    try {
      const r = await addAgentKbLinks(editingId, urls)
      setKbReport(
        `Добавлено страниц: ${r.added.length}` +
        (r.failed.length ? ` · не открылись: ${r.failed.map((f) => `${f.url} (${f.reason})`).join('; ')}` : ''),
      )
      if (!r.failed.length) setKbLinks('')
      setKb(await fetchAgentKb(editingId))
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось добавить ссылки', desc: e instanceof Error ? e.message : '' })
    } finally { setKbBusy(false) }
  }

  const addKb = async () => {
    if (!editingId || !kbContent.trim()) return
    try {
      await createAgentKb(editingId, { title: kbTitle.trim(), content: kbContent.trim() })
      setKbTitle(''); setKbContent('')
      setKb(await fetchAgentKb(editingId))
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось добавить', desc: e instanceof Error ? e.message : '' }) }
  }

  const removeKb = async (k: AgentKbItem) => {
    if (!editingId) return
    try { await deleteAgentKb(editingId, k.id); setKb(await fetchAgentKb(editingId)) }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' }) }
  }

  const load = async () => {
    try { setAgents(await fetchAgents()) }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось загрузить агентов', desc: e instanceof Error ? e.message : '' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const set = (patch: Partial<AgentInput>) => setForm((f) => ({ ...(f as AgentInput), ...patch }))

  const openNew = () => { setEditingId(null); setForm({ ...EMPTY }); setKb([]) }
  const openEdit = (a: Agent) => {
    setEditingId(a.id)
    setForm({ name: a.name, toneOfVoice: a.toneOfVoice, restrictions: a.restrictions, character: a.character, language: a.language, audience: a.audience, completionCriteria: a.completionCriteria, firstMessage: a.firstMessage })
    setKb([]); setKbTitle(''); setKbContent('')
    void fetchAgentKb(a.id).then(setKb).catch(() => {})
  }

  const save = async () => {
    if (!form?.name.trim()) return pushToast({ type: 'error', title: 'Укажите название агента' })
    setSaving(true)
    try {
      if (editingId) { await updateAgent(editingId, form); pushToast({ type: 'success', title: 'Агент сохранён' }) }
      else { await createAgent(form); pushToast({ type: 'success', title: 'Агент создан' }) }
      setForm(null); setEditingId(null); await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  const duplicate = async (a: Agent) => {
    try {
      await createAgent({ name: `${a.name} — копия`, toneOfVoice: a.toneOfVoice, restrictions: a.restrictions, character: a.character, language: a.language, audience: a.audience, completionCriteria: a.completionCriteria, firstMessage: a.firstMessage })
      pushToast({ type: 'success', title: 'Агент скопирован' })
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось скопировать', desc: e instanceof Error ? e.message : '' }) }
  }

  const remove = async (a: Agent) => {
    if (!(await confirmDialog({ title: 'Удалить агента?', message: `«${a.name}» будет удалён.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteAgent(a.id); pushToast({ type: 'success', title: 'Агент удалён' }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка удаления', desc: e instanceof Error ? e.message : '' }) }
  }

  // ── Форма создания/редактирования ──
  if (form) {
    return (
      <div>
        <button onClick={() => { setForm(null); setEditingId(null) }} className="btn-ghost mb-3 h-9"><X size={15} /> Назад к агентам</button>
        <PageHeader title={editingId ? 'Изменить агента' : 'Новый агент'} subtitle="Как персона общается: тон, характер, что нельзя. Цель отдельно — она про результат." icon={<Bot size={22} />} />
        <Card className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-xs text-white/50">Название *</label>
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Напр. Дружелюбный эксперт" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Характер / роль</label>
              <textarea className="input min-h-[76px] resize-y" value={form.character || ''} onChange={(e) => set({ character: e.target.value })} placeholder="Напр. опытный трейдер, спокойный, делится опытом без навязчивости" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Тон общения <span className="text-white/30">— как писать</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.toneOfVoice || ''} onChange={(e) => set({ toneOfVoice: e.target.value })} placeholder="Напр. на «ты», коротко, без канцелярита и восклицаний" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div>
              <label className="mb-1 block text-xs text-white/50">Ограничения <span className="text-white/30">— чего нельзя</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.restrictions || ''} onChange={(e) => set({ restrictions: e.target.value })} placeholder="Напр. не обещать доход, не давить, не отправлять ссылку без согласия" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Язык <span className="text-white/30">— необязательно</span></label>
              {/* Список, а не свободный ввод: руками писали «русский», «Русский», «ru»,
                  «rus» — в промпт уходило что попало. Поиск нужен, вариантов три десятка. */}
              <Select
                value={form.language || ''}
                onChange={(v) => set({ language: v })}
                options={LANGUAGES}
                searchable
                placeholder="Язык собеседника"
              />
            </div>
          </div>

          {/* Аудитория и критерий завершения переехали из цели (24.07): цель — это
              счётчик результата, а «с кем говорим» и «когда разговор доведён» —
              свойства самого разговора, то есть агента. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">С кем говорим <span className="text-white/30">— портрет собеседника</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.audience || ''} onChange={(e) => set({ audience: e.target.value })} placeholder="Напр. новички в крипте, 25–40, боятся потерять деньги" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Разговор доведён, когда <span className="text-white/30">— критерий завершения</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.completionCriteria || ''} onChange={(e) => set({ completionCriteria: e.target.value })} placeholder="Напр. перешёл по ссылке и написал, что вступил" />
            </div>
          </div>

          {/* Первое сообщение для холодного контакта (мейлинг). Переехало из цели (24.07):
              «как заговорить первым» — свойство персоны. Варианты — через пустую строку. */}
          <div>
            <label className="mb-1 block text-xs text-white/50">
              Первое сообщение <span className="text-white/30">— для рассылки (мейлинг). Несколько вариантов — через пустую строку, чередуются по кругу</span>
            </label>
            <textarea
              className="input min-h-[110px] resize-y font-mono text-sm"
              value={form.firstMessage || ''}
              onChange={(e) => set({ firstMessage: e.target.value })}
              placeholder={'Привет! Увидел твой профиль — тоже в теме крипты?\n\nЗдравствуйте! Заметил вас в чате, можно спросить пару слов?'}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { setForm(null); setEditingId(null) }} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void save()} disabled={saving} className="btn-primary h-10">{editingId ? 'Сохранить' : 'Создать'}</button>
          </div>
        </Card>

        {/* База знаний переехала из цели (24.07): факты о продукте — то, на что
            персона опирается в разговоре, а не измеримый результат. Доступна только
            у сохранённого агента: записи привязываются к его id. */}
        {editingId ? (
          <Card className="mt-3 space-y-3 p-4">
            <div>
              <div className="text-sm font-semibold text-fg">База знаний</div>
              <div className="mt-0.5 text-xs text-white/45">
                Факты о продукте, на которые агент опирается в разговоре. Попадают в промпт —
                без них ИИ выдумывает детали.
              </div>
            </div>
            {/* Три способа положить знание — все на экране сразу, без вкладок.
                За вкладками не видно, что вообще можно загрузить: оператор открывает
                форму и должен видеть все возможности, а не искать их переключателем. */}
            <div className="grid gap-3 lg:grid-cols-2">
              {/* Файлы */}
              <div
                onDragOver={(e) => { e.preventDefault(); setKbDrag(true) }}
                onDragLeave={() => setKbDrag(false)}
                onDrop={(e) => { e.preventDefault(); setKbDrag(false); void addFiles(e.dataTransfer.files) }}
                className={`flex flex-col rounded-xl border border-dashed p-4 text-center transition-colors ${
                  kbDrag ? 'border-spark-500 bg-spark-500/8' : 'border-line'
                }`}
              >
                <div className="mb-2 flex items-center gap-1.5 text-left text-xs font-semibold text-white/70">
                  <Paperclip size={13} className="text-white/40" /> Файлы
                </div>
                <div className="flex flex-1 flex-col items-center justify-center">
                  <Upload size={20} className="text-white/30" />
                  <div className="mt-2 text-sm text-white/70">
                    Перетащите сюда — <b>можно сразу несколько</b>
                  </div>
                  <div className="mt-0.5 text-xs text-white/40">
                    PDF, Word, Excel, txt, csv, картинки · до 3 МБ каждый
                  </div>
                  <button onClick={() => kbFileRef.current?.click()} disabled={kbBusy} className="btn-ghost mt-2 h-9 text-sm">
                    {kbBusy ? <><Loader2 size={14} className="animate-spin" /> Загружаю…</> : 'Выбрать файлы'}
                  </button>
                  <input
                    ref={kbFileRef} type="file" multiple hidden
                    onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }}
                  />
                </div>
              </div>

              {/* Ссылки и страницы */}
              <div className="rounded-xl border border-line p-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/70">
                  <LinkIcon size={13} className="text-white/40" /> Ссылки и страницы
                </div>
                <textarea
                  className="input min-h-[92px] resize-y font-mono text-xs"
                  value={kbLinks}
                  onChange={(e) => setKbLinks(e.target.value)}
                  placeholder={'https://сайт.рф/tarify\nhttps://сайт.рф/faq\nhttps://teletype.in/@me/about'}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button onClick={() => void addLinks()} disabled={kbBusy || !kbLinks.trim()} className="btn-primary h-9 px-3 text-sm disabled:opacity-40">
                    {kbBusy ? <><Loader2 size={14} className="animate-spin" /> Читаю страницы…</> : <><Plus size={14} /> Добавить ссылки</>}
                  </button>
                  <span className="text-xs text-white/40">
                    По одной в строке. Текст страницы скачаем сразу — по ссылке ИИ не ходит.
                  </span>
                </div>
              </div>
            </div>

            {/* Короткий факт текстом */}
            <div className="rounded-xl border border-line p-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/70">
                <FileText size={13} className="text-white/40" /> Короткий факт текстом
              </div>
              <div className="grid gap-2 sm:grid-cols-[200px_1fr_auto]">
                <input className="input" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} placeholder="Заголовок (напр. Цена)" />
                <input
                  className="input" value={kbContent}
                  onChange={(e) => setKbContent(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addKb() }}
                  placeholder="Факт: напр. 3 тарифа, от 990 ₽ в месяц"
                />
                <button onClick={() => void addKb()} disabled={!kbContent.trim()} className="btn-primary h-10 px-3 disabled:opacity-40"><Plus size={15} /> Добавить</button>
              </div>
            </div>

            {kbReport && <div className="text-xs text-white/50">{kbReport}</div>}

            {kb.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-white/40">В базе записей: {kb.length}</div>
                {kb.map((k) => (
                  <div key={k.id} className="flex items-start gap-2 rounded-lg border border-line bg-elevated/40 px-3 py-2 text-sm">
                    <span className="mt-0.5 shrink-0 text-white/30">
                      {k.kind === 'link' ? <LinkIcon size={13} /> : k.kind === 'text' ? <FileText size={13} /> : <Paperclip size={13} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      {k.title && <span className="font-semibold text-white">{k.title}</span>}
                      {k.url && (
                        <a href={k.url} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-iris-300 hover:underline">открыть</a>
                      )}
                      {/* Страницы и файлы кладут в базу килобайты текста — в списке
                          показываем начало, иначе одна запись займёт весь экран. */}
                      <div className="truncate text-xs text-white/50">{k.content}</div>
                    </div>
                    <button onClick={() => void removeKb(k)} className="btn-icon-danger h-7 w-7 shrink-0" aria-label="Удалить запись"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <p className="mt-3 text-xs text-white/40">
            База знаний появится после сохранения — записи привязываются к агенту.
          </p>
        )}
      </div>
    )
  }

  // ── Список ──
  return (
    <div>
      <PageHeader
        title="Агенты"
        subtitle="Как общается ИИ: тон, характер, ограничения. Выбираются в задачах кампании, как цель. Цель — про результат, агент — про манеру."
        icon={<Bot size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="goals" className="h-10 w-10" /><button onClick={openNew} className="btn-primary h-9"><Plus size={15} /> Агент</button></div>}
      />
      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : agents.length === 0 ? (
        <EmptyState icon={<Bot size={26} />} title="Агентов пока нет" desc="Создайте персону — тон и характер, которыми ИИ общается. Одного агента можно выбирать в разных кампаниях." action={<button onClick={openNew} className="btn-primary h-9"><Plus size={15} /> Создать агента</button>} />
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-start gap-2 p-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-300"><Bot size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{a.name}</span>
                  {a.language && <Badge tone="muted">{a.language}</Badge>}
                </div>
                {a.character && <div className="mt-0.5 text-xs text-white/60">{a.character}</div>}
                {a.toneOfVoice && <div className="mt-0.5 text-xs text-white/40">тон: {a.toneOfVoice}</div>}
                {a.restrictions && <div className="mt-0.5 text-xs text-rose-300/70">нельзя: {a.restrictions}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => openEdit(a)} className="btn-icon h-8 w-8" aria-label="Изменить" title="Изменить"><Pencil size={14} /></button>
                <button onClick={() => void duplicate(a)} className="btn-icon h-8 w-8" aria-label="Дублировать" title="Дублировать"><Copy size={14} /></button>
                <button onClick={() => void remove(a)} className="btn-icon-danger h-8 w-8" aria-label="Удалить" title="Удалить"><Trash2 size={14} /></button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
