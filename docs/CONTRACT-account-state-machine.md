# CONTRACT · State machine статусов аккаунта

> Контракт Фазы 0 (Lane A). Источник истины кода — `server/lib/accountStatus.js`
> (чистый модуль без I/O, целиком покрыт юнит-тестами). Этот документ описывает
> контракт; при расхождении правим **обе** стороны в одном PR. ТЗ: §3.3, §4.

## 1. Зачем

Статус аккаунта отвечает на вопрос **«можно ли вообще брать этот аккаунт в работу»**.
Он ортогонален локу (`accountLocks.js`) — лок отвечает «занят ли он прямо сейчас
конкретной задачей». Один аккаунт может быть `active` (статус разрешает работу) и при
этом залочен задачей нейрокомментинга (сейчас занят).

## 2. Канонический набор статусов (§3.3)

| Статус | Значение | Runnable? |
|---|---|---|
| `active` | Рабочий, готов к назначению | ✅ да |
| `warming` | На прогреве — блокирован для остальных модулей (§3.3) | ⛔ нет* |
| `pause` | Ручная пауза оператора | ⛔ нет |
| `floodwait` | Telegram FloodWait (временный, есть `statusUntil`) | ⛔ нет |
| `quarantine` | Карантин после риск-события (временный/ручной) | ⛔ нет |
| `spamblock` | Спам-блок Telegram | ⛔ нет |
| `reauth` | Требуется переавторизация сессии | ⛔ нет |
| `invalid` | Терминальный: сессия мертва | ⛔ нет |

\* `warming` runnable **только** для модуля прогрева (`WARMING_MODULE = 'warming'`).

`isRunnable(status)` = статус не входит в `NON_RUNNABLE` (всё, кроме `active`).
`TERMINAL = { invalid }` — выход только ручным удалением/переавторизацией.

### Legacy-маппинг (`normalizeStatus`)

Старые данные приводятся к канону: `working|valid|none|'' → active`,
`frozen → quarantine` (развести `frozen` — TODO, 🔒 §6). Неизвестный статус → `active`.

## 3. Разрешения на использование

- `canModuleUseAccount(moduleKey, status)` — прогрев берёт `active|warming`;
  остальные модули — только `isRunnable` (фактически `active`).
- `canAssign(status)` = `isRunnable(status)`. Исключение «горячий лид» (§3.3/§4:
  не переводить в другой статус, диалог продолжается) обрабатывает **вызывающий**,
  не сама машина.

## 4. Временные статусы и авто-возврат

`floodwait` и `quarantine` могут нести `statusUntil` (ms). Когда `now >= statusUntil`:

- `isStatusExpired(meta)` → `true`;
- `nextStatusAfterExpiry(meta)`:
  - `floodwait` → `prevStatus` (если он runnable, иначе `active`);
  - `quarantine` → `warming` (не сразу в `active`: авто-возврат по trust не определён —
    🔒 §6, поэтому на перепрогрев, а не в бой).

## 5. Таблица переходов (`TRANSITIONS`)

Тождественный переход (`from === to`) всегда разрешён. Иначе — только по таблице:

| Из \ В | active | warming | pause | floodwait | quarantine | spamblock | reauth | invalid |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **active** | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **warming** | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **pause** | ✅ | ⛔ | — | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |
| **floodwait** | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| **quarantine** | ✅ | ✅ | ✅ | ⛔ | — | ⛔ | ✅ | ✅ |
| **spamblock** | ✅ | ⛔ | ✅ | ⛔ | ✅ | — | ✅ | ✅ |
| **reauth** | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | — | ✅ |
| **invalid** | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | — |

`canTransition(from, to)` возвращает `false` для запрещённых. `buildStatusPatch` бросает
`ILLEGAL_TRANSITION:<from>-><to>` — недопустимую смену статуса нельзя сохранить.

## 6. Патч статуса (`buildStatusPatch`)

Собирает (не сохраняет — сохраняет вызывающий через `setAccountMeta`) поля meta:

```
status, statusReason, statusCode, statusSince (ms), statusUntil (ms|null),
statusBy (initiator), prevStatus
```

`statusBy`/`initiator` и `statusReason`/`statusCode` — те же поля, что уходят в
единый аудит-лог (см. [CONTRACT-audit-log.md](./CONTRACT-audit-log.md)): каждая смена
статуса аккаунта должна порождать аудит-запись с инициатором и причиной (§5.2).

## 7. Открытые вопросы (🔒 §6)

- Формула trust score → авто-переходы `quarantine → active` без ручного решения.
- Разведение `frozen` (сейчас = `quarantine`) в отдельный бизнес-статус.
- Safety-лимиты, задающие пороги перехода в `floodwait`/`spamblock`.
