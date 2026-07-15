# ARCH · Схема сущностей: Proxy / Task / Channel + граница адаптера

> Контракт Фазы 0 (§3.10). Дополняет [ARCH-goals-crm.md](./ARCH-goals-crm.md) (Goal/KB/Lead)
> и [CONTRACT-account-state-machine.md](./CONTRACT-account-state-machine.md) (Account).
> Здесь — оставшиеся сущности и граница «общий слой ↔ Telegram-специфика».
> Источник истины кода: `server/proxies.js`, `server/lib/taskStore.js` (+ `src/api/modulesApi.ts`),
> `server/channels.js`.

## 1. Карта сущностей

```
Profile(User)         Account(бот)          Proxy
   │ роль(RBAC)          │ статус               │ kind/страна/статус
   │                     ├── proxy(URL) ────────┘ (account.proxy = toProxyUrl)
   │                     │
Goal ──1:N── KB          └── Task ──N:1── Goal
   └──1:N── Lead ──N:1── Account            Task ──N:M── Channel (targets)
                                            Channel  (lease: 1 канал — 1 бот)
```

- **Account ↔ Proxy** — через строку `account.proxy` (URL). Каталог `Proxy` строит эту строку
  (`toProxyUrl`), парсит её `server/proxy.js#parseProxy` для GramJS.
- **Task ↔ Goal** — `task.goalId` (задача «к цели»).
- **Task ↔ Channel** — цели задачи (`settings.targets`/`channels`); при обновлении статистики —
  lease «один канал — один бот» ([CONTRACT-locks-lease.md](./CONTRACT-locks-lease.md)).

## 2. Proxy (`server/proxies.js`)

```jsonc
{
  "id": "px_xxxxxxxx",
  "label": "Ферма UA #1",
  "kind": "static | mobile | farm",   // статический / мобильный / своя ферма
  "scheme": "socks5 | http",
  "host": "1.2.3.4", "port": 1080,
  "username": "", "password": "",
  "country": "ua",                     // код из GEO-модели (geo.ts)
  "status": "ok | dead | unknown",
  "note": "", "lastCheckAt": null,
  "createdAt": ms, "updatedAt": ms
}
```

CRUD `/api/proxies`, назначение — на странице `/panel/proxies` (мультивыбор аккаунтов →
`patchAccount(proxy=toProxyUrl)`). Открыто (🔒→снято 14.07: своя ферма + докупаемые):
цепочка `SIM/device/IMEI` и live-проверка живости — далее.

## 3. Task (`server/lib/taskStore.js`, DTO — `src/api/modulesApi.ts`)

```jsonc
{
  "id": "<idPrefix>_xxxxxxxx",          // префикс на модуль (registry.MODULE_DEFS)
  "moduleKey": "neuro-commenting | … | mailing",
  "status": "queued | running | stopped | done | error",
  "initiator": "operator | scheduler | worker | system",  // §3.9
  "goalId": "goal_… | null",            // §3.6, «к цели»
  "campaignId": "… | null",
  "createdAt": ms, "updatedAt": ms,
  "progress": { "done": n, "total": n, "actionsDone": n, "commentsSent": n },
  "settings": { /* ModuleTaskSettings: accountIds, targets, лимиты, задержки, … */ },
  "logs": [ /* LogEntry: операционные логи задачи */ ],
  "history": [], "commentHistory": [], "results": [],
  "accountStats": { "<accountId>": { "actions": n, "comments": n, "floodWaits": n } }
}
```

Каждый запуск модуля = Task. Трекер (стоп/рестарт/прогресс/ошибки) — `/panel/tasks`
(«Дашборд задач», §8.8). Пауза/продолжение — hot-path воркеров (на live). Операционные
`logs` — отдельный поток от аудита ([CONTRACT-audit-log.md](./CONTRACT-audit-log.md)).

## 4. Channel (`server/channels.js`)

```jsonc
{
  "id": "ch_xxxxxxxx",
  "title": "", "link": "", "username": "",
  "category": "", "language": "", "region": "",
  "subscribers": 0, "activity": null, "hasComments": null, "rating": null,
  "tgPeerId": null,
  "botInGroup": false,                  // true → авто-статистика ~раз в час (решение 14.07)
  "sources": ["parse:<taskId>"],        // откуда пришёл (дедуп по channelKey)
  "categoriesExtra": [],
  "lastStatsAt": null, "statsBy": null, // дата/источник актуальности статистики
  "createdAt": ms, "updatedAt": ms
}
```

Дедуп по `channelKey` (username/peerId). База — `/panel/channels`; наполняется парсером
(`upsertMany`) и обновляется оркестратором статистики (lease + `refreshOneChannel`).

## 5. Граница адаптера (§3.10)

**Общий слой (платформо-независимый)** — сущности и бизнес-логика: `Goal/KB/Lead`,
`Task`/оркестрация, `Channel`/`Proxy`/`Account`-статусы, локи/lease, аудит, RBAC. Не знает
про GramJS.

**Telegram-специфика** — вынесена в: `server/lib/gramHelpers.js`, `server/proxy.js`
(parseProxy/clientOptions), воркеры `server/modules/workers.js` (join/sendComment/sendMessage/
reactions/importContacts). Только этот слой вызывает GramJS.

**Правило для мультиплатформы (Фаза 4):** при добавлении Instagram — новый адаптер рядом
с Telegram-слоем, реализующий тот же контракт действий (join/send/react/parse); общий слой
и сущности не меняются. Переключатель платформы — над адаптерами, не внутри бизнес-логики.

## 6. Открытые вопросы

- Полная цепочка `SIM/device/IMEI` в Proxy (глубже инфра, §3.4).
- Формальный интерфейс адаптера действий (когда появится 2-я платформа, §3.10) 🔒.
