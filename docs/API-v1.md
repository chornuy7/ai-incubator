# API v1 — для внешнего AI-оркестратора («мозги») · §10.3

> Закрытый API, которым внешний AI создаёт цели/кампании/задачи, спрашивает, что
> умеет модуль, и получает оценку стоимости/времени до запуска. Всё под ключом.

## Аутентификация

Каждый запрос — с заголовком:

```
Authorization: Bearer aii_live_sk_…
```

Ключ выпускает **владелец** в админке (или `POST /api/admin/api-keys`). Полное
значение показывается **один раз** при создании — дальше в списке только префикс.
Отозвать: `DELETE /api/admin/api-keys/:id`.

Без ключа или с отозванным — `401`.

## Эндпоинты

### Что умеет каждый модуль

```
GET /api/v1/capabilities
```

Список модулей: ключ, название, нужны ли цели (`requiresTargets`), цены (подписка
$/мес и ⚡/действие), и шаблон тела для запуска (`run`).

### MCP-манифест

```
GET /api/v1/mcp
```

Те же возможности как список инструментов (`tools`): `create_goal`,
`create_campaign`, `estimate`, `run_<module>`. Оркестратор берёт tools отсюда, а
вызывает обычными POST ниже.

### Цели

```
GET  /api/v1/goals
POST /api/v1/goals      { name, metric?, target?, deadline? (YYYY-MM-DD) }
```

### Кампании

```
GET  /api/v1/campaigns
POST /api/v1/campaigns  { name, modules: string[], goalId? }
```

### Оценка до запуска (стоимость + время)

```
POST /api/v1/modules/:key/estimate   { actions, accounts? }
```

Ответ: `cost.actionsCoins` (⚡ за действия) и `time.minSec/maxSec` (действия делятся
между аккаунтами, задержка 30–120 c). Токены ИИ добавляются по факту — заранее
неизвестны.

### Запуск модуля

```
POST /api/v1/modules/:key/run
{ accountIds: string[], targets?: string[], maxActions?, goalId?, campaignId? }
```

Валидации те же, что в UI (это одна и та же серверная функция). Ответ: `taskId`.

## Пример

```bash
KEY=aii_live_sk_…

# что умеет
curl -H "Authorization: Bearer $KEY" http://localhost:3001/api/v1/capabilities

# создать цель
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"200 переходов в бота","target":200}' \
  http://localhost:3001/api/v1/goals

# оценить
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"actions":100,"accounts":10}' \
  http://localhost:3001/api/v1/modules/neuro-commenting/estimate

# запустить
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"accountIds":["acc_…"],"targets":["@channel"],"maxActions":50,"goalId":"goal_…"}' \
  http://localhost:3001/api/v1/modules/neuro-commenting/run
```

## Что ещё нужно решить (§10.3)

- **Область ключа.** Сейчас ключ пускает ко всем действиям API. Нужны ли scoped-ключи
  (только чтение / только конкретные модули) — вопрос к бизнесу.
- **Хранение.** Демо хранит полное значение в `data/api-keys.json`. Продакшн-шаг —
  только хэш; интерфейс issue/verify/revoke не изменится. С переходом на Supabase
  (§10.2) ключи и их проверка переезжают в таблицу + RLS.
- **Полноценный MCP-сервер** (stdio/SSE) поверх этого HTTP-API — если оркестратор
  ждёт именно MCP-протокол, а не REST + манифест.
