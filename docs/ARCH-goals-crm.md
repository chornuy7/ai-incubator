# ARCH · Цели → База знаний → Лиды/CRM

> Архитектурный контракт Фазы 0 (Lane B, P0). Источник истины кода — `server/goals.js`,
> `server/knowledgeBase.js`, `server/leads.js` (+ роутеры `*Routes.js`,
> `server/lib/goalContext.js`). ТЗ: §3.6. Хранение — JSON в `server/data/` (gitignored),
> пути переопределяются env (`GOALS_FILE`/`KB_FILE`/`LEADS_FILE`) для изоляции тестов.

## 1. Идея слоя

ИИ всегда работает **к цели**. Цепочка: оператор ставит **Цель** → наполняет её
**Базой знаний** → задачи модулей (нейрокомментинг/нейрочаттинг) получают
`goalId`, и генерация идёт с учётом цели+KB → результат оседает в **CRM** как **Лиды**
с воронкой статусов. Это отдельный слой над модулями, а не часть какого-то одного модуля.

```
Goal ──1:N── KnowledgeBase
  │
  └──1:N── Lead ──N:1── Account (ответственный)
Task.goalId ──N:1── Goal        (задача выполняется «к цели»)
```

## 2. Goal (`goals.js`)

```jsonc
{
  "id": "goal_xxxxxxxx",
  "name": "…",                 // обязательно, непустое
  "description": "…",
  "targetAction": "…",         // целевое действие (что считаем конверсией)
  "stages": ["…"],             // этапы ведения к цели
  "completionCriteria": "…",   // критерий «цель достигнута»
  "audience": "…",             // описание аудитории
  "createdAt": ms, "updatedAt": ms
}
```

Редактируемые поля: `name, description, targetAction, stages, completionCriteria, audience`.
CRUD: `listGoals/getGoal/createGoal/updateGoal/deleteGoal`. Пустое имя → ошибка.
Удаление цели должно каскадно чистить её KB (`deleteKbByGoal`).

## 3. KnowledgeBase (`knowledgeBase.js`)

```jsonc
{
  "id": "kb_xxxxxxxx",
  "goalId": "goal_xxxxxxxx",   // обязательно
  "kind": "text|file|image",   // MVP: реально работает text; file/image — §6
  "title": "…",
  "content": "…",              // для text
  "fileRef": null,             // ссылка на файл (file/image) — §6, OCR открыт
  "scope": "all",              // область применимости знания
  "version": 1,                // растёт при updateKb
  "createdAt": ms, "updatedAt": ms
}
```

CRUD: `listKb(goalId?)/createKb(goalId,…)/updateKb/deleteKb/deleteKbByGoal`.
Пустая text-запись (без content и title) → ошибка.

## 4. Lead (`leads.js`)

```jsonc
{
  "id": "lead_xxxxxxxx",
  "goalId": "goal_xxxxxxxx|null",
  "accountId": "…|null",       // ответственный аккаунт (кто ведёт диалог)
  "peer": "username|id",       // обязательно — с кем диалог
  "status": "cold|answered|hot|target|closed",
  "isHot": bool,               // производное: status === 'hot'
  "result": "…",
  "note": "…",
  "createdAt": ms, "updatedAt": ms
}
```

Воронка (`LEAD_STATUSES`): `cold → answered → hot → target → closed`
(холодный → ответил → горячий → целевое действие → закрыт). CRUD:
`listLeads(filter)/createLead/updateLead/deleteLead`; аналитика — `leadStats(goalId?)`
(`{ total, byStatus }`). Фильтры: `goalId`, `status`, `accountId`.

## 5. Связка с задачами и генерацией

- `Task.goalId` (см. `modulesApi.ModuleTask`) — задача помнит, к какой цели запущена.
- `server/lib/goalContext.js#buildGoalContext` инъектит цель+KB в системный промпт ИИ,
  чтобы и нейрокомментинг, и нейрочаттинг генерировали **к цели с базой знаний**.
- Приоритет ответившему лиду и лимиты по активным диалогам (§3.6) — на этапе live
  нейрочата (пока скелет).

## 6. Открытые вопросы (🔒 §6)

- KB `kind: file|image` + OCR/парсинг вложений (`fileRef`).
- Семантический/векторный поиск по KB и тональность (§3.5/§3.6).
- Матрица прав доступа к целям/CRM (RBAC, §8.1).
