# Контракт: State machine статусов аккаунта

> **Фаза 0 · Lane A.** Источник истины по требованиям: [TZ-2026-07-10.md](./TZ-2026-07-10.md) §3.3, §4.
> Это **контракт** (интерфейс между дорожками), а не реализация. Расширяет то, что уже есть:
> [`server/accountsMeta.js`](../server/accountsMeta.js), [`server/lib/protection.js`](../server/lib/protection.js),
> [`server/lib/accountRunner.js`](../server/lib/accountRunner.js), [`server/lib/accountLocks.js`](../server/lib/accountLocks.js).

## 1. Термины

- **Аккаунт** — управляемый Telegram-бот (не путать с «профилем»-человеком, см. [CLAUDE.md](../CLAUDE.md)).
- **Статус** — жизненный цикл аккаунта, хранится в `accounts-meta.json` (`meta.status`).
- **Lock** — оперативная занятость аккаунта задачей (в памяти процесса, см. [CONTRACT-locks-lease.md](./CONTRACT-locks-lease.md)).
  Статус и lock — **ортогональны**: статус отвечает на «можно ли вообще брать аккаунт в работу»,
  lock — «занят ли он прямо сейчас конкретной задачей».

## 2. Целевой набор статусов (§3.3)

| Статус | Значение | Аккаунт доступен рабочим модулям? |
|---|---|---|
| `active` | Готов к работе, прогрет, свободен | ✅ да |
| `warming` | Идёт прогрев — аккаунт монопольно занят сценарием прогрева | ❌ нет (кроме «горячего лида», см. §6) |
| `pause` | Оператор вручную приостановил | ❌ нет |
| `floodwait` | Telegram вернул FLOOD_WAIT — временное ограничение с таймером | ❌ нет (до истечения) |
| `quarantine` | Авто-изоляция после N FloodWait/подозрительной активности | ❌ нет (до восстановления) |
| `spamblock` | Telegram пометил спам (SPAM/PEER_FLOOD) | ❌ нет |
| `reauth` | Требуется повторная авторизация (нет/протухла сессия) | ❌ нет |
| `invalid` | Бан/деактивация — аккаунт мёртв | ❌ нет |

## 3. Маппинг на текущий код (что уже есть → цель)

| Сейчас в коде | Где ставится | Решение контракта |
|---|---|---|
| `active` | дефолт `accountsMeta.js`; `disconnectAccount` | остаётся `active` |
| `working` | `accountRunner.connectAccount` на время задачи | **не статус жизненного цикла**, а «занят задачей» → уходит в **lock**. В `meta.status` держим `active`, факт работы = наличие lock. Мигрируется в Фазе 1. |
| `warming` | ставится в UI/прогреве | остаётся `warming`, но получает **явную блокировку назначения** (§3.3) |
| `quarantine` | `accountRunner.handleFlood`/`applyBanPolicy` | остаётся `quarantine` |
| `spamblock` | `accountRunner.applyBanPolicy` | остаётся `spamblock` |
| `reauth` | `accountRunner.connectAccount` (нет сессии) | остаётся `reauth` |
| `invalid` | `accountRunner.applyBanPolicy` (бан) | остаётся `invalid` |
| `frozen` | в `SKIP_STATUSES` (`protection.js`) + фронт | 🔒 **требует решения (§6):** мапить на `quarantine` или оставить синонимом? Пока — синоним «нерабочего», TODO развести. |
| `floodwait` (нет) | сейчас FloodWait = `sleep()` в `handleFlood`, статус не пишется | **новый статус** — при FLOOD_WAIT ставить `floodwait` c `until`, снимать по таймеру. Реализация — Фаза 1. |
| `pause` (нет) | — | **новый статус** — ручная пауза оператора. Реализация — Фаза 1. |

`protection.isAccountRunnable()` сейчас скипает `quarantine/spamblock/invalid/frozen/reauth`.
**Контракт:** новый набор SKIP = `warming*, pause, floodwait, quarantine, spamblock, reauth, invalid`
(`warming` — с исключением «горячий лид», §6). Правку `SKIP_STATUSES` делает Lane A в Фазе 1.

## 4. Метаданные статуса (расширение `meta`)

К каждому не-`active` статусу привязываем причину/срок (§3.3 «хранить причину, длительность, разрешённые действия»):

```jsonc
{
  "status": "floodwait",
  "statusReason": "FLOOD_WAIT_420",      // код/причина
  "statusSince": 1752200000000,           // когда вошли в статус
  "statusUntil": 1752200420000,           // когда авто-выход (floodwait/quarantine); null = бессрочно
  "statusBy": "system|<profileId>",       // кто перевёл (аудит, §4)
  "prevStatus": "active"                   // куда вернуться после снятия
}
```

Поля добавляются к существующему `meta` через `setAccountMeta()` — обратносовместимо (старые записи без них читаются как `active`).

## 5. Переходы (кто/что триггерит)

```
                 ┌─────────────────────────── manual: оператор ──────────────────────────┐
                 │                                                                        │
   reauth ──login success──> active <──restore(trust ok)── quarantine <──N×floodwait──┐   │
     ▲                        │  │  ▲                          ▲                       │   │
     │no session              │  │  └──── warming done ────── warming                  │   │
     │                        │  │                              ▲                      │   │
  active/*                    │  └── start task (lock) ─────────┘ auto: trust↓ / manual │   │
                              │                                                         │   │
                              ├── FLOOD_WAIT ──> floodwait ──timer──> (prevStatus)──────┘   │
                              ├── SPAM/PEER_FLOOD ──> spamblock ──manual/policy──> quarantine│
                              ├── BAN/DEACTIVATED ──> invalid (терминальный)                 │
                              └── operator pause ──> pause ──operator resume──> active ──────┘
```

**Таблица переходов** (источник → цель · триггер · где в коде):

| Из | В | Триггер | Код (сейчас / план) |
|---|---|---|---|
| `active` | `warming` | старт прогрева | UI / warming worker |
| `warming` | `active` | прогрев завершён + trust ok | warming worker _(🔒 порог trust — §6)_ |
| `active` | `floodwait` | FLOOD_WAIT от Telegram | `accountRunner.handleFlood` (добавить запись статуса) |
| `floodwait` | `prevStatus` | истёк `statusUntil` | новый reconciler по таймеру |
| `floodwait`×N | `quarantine` | ≥ `floodQuarantineThreshold` (деф. 3) | `handleFlood` уже считает; порог настраиваемый (§3.3) |
| `active` | `spamblock` | SPAM/PEER_FLOOD | `applyBanPolicy` |
| `spamblock` | `quarantine` | политика `onSpamblock` | `applyBanPolicy` |
| `active` | `invalid` | USER_BANNED/DEACTIVATED | `applyBanPolicy` |
| `active` | `quarantine` | падение trust score | 🔒 auto-стоп по trust (§6, формула не определена) |
| `quarantine` | `active`/`warming` | восстановление trust | 🔒 (§6) — вернуть в прогрев, затем в пул |
| `*` | `pause` | оператор | новый ручной переход + аудит (§4) |
| `pause` | `active` | оператор | новый ручной переход + аудит |
| `active`/`*` | `reauth` | нет/протухла сессия | `accountRunner.connectAccount` |
| `reauth` | `active` | успешный логин | `tgAuth` |

Терминальный статус: `invalid` (выход только ручным удалением/переавторизацией).

## 6. Разрешённые действия по статусу

| Статус | Ручное назначение в модуль | Автоназначение оркестратором | Продолжение активного «горячего лида» |
|---|---|---|---|
| `active` | ✅ | ✅ | ✅ |
| `warming` | ❌ | ❌ | ✅ **исключение** (§3.3/§4: диалог не обрывается, статус не меняем) |
| `pause` | ❌ | ❌ | ❌ |
| `floodwait` | ❌ | ❌ | ⏸ отложить до `statusUntil` |
| `quarantine` | ❌ | ❌ | ❌ |
| `spamblock` | ❌ | ❌ | ❌ |
| `reauth` | ❌ | ❌ | ❌ |
| `invalid` | ❌ | ❌ | ❌ |

«Горячий лид» = активный диалог со статусом лида `hot` (см. [ARCH-goals-crm.md](./ARCH-goals-crm.md)).
Технический способ «как отвечать горячему лиду при прогреве» — 🔒 **§6, требует решения** (safety-лимиты).

## 7. Инварианты (для тестов, §3.3 «≥5 тестовых профилей»)

1. Аккаунт в `warming` не может быть залочен рабочим модулем (кроме горячего лида).
2. Переход в `floodwait/quarantine/spamblock/invalid` всегда пишет аудит-запись (`statusBy`, `statusReason`) — см. [CONTRACT-audit-log.md](./CONTRACT-audit-log.md).
3. `floodwait` с истёкшим `statusUntil` не должен оставаться нерабочим (reconciler возвращает `prevStatus`).
4. Ручной перенос между статусами (`pause`, force-снятие) требует подтверждения и инициатора (§3.2/§4).
5. Статус и lock согласованы: снятие всех локов не меняет статус; смена на нерабочий статус обязана освобождать локи задач этого аккаунта.

## Открытые вопросы (§6) — не выдумывать

- 🔒 Формула **trust score** и пороги авто-стопа/возврата → пороги переходов `active↔quarantine`.
- 🔒 Разрешённые действия при `SpamBlock/FloodWait/Quarantine` и **технический ответ горячему лиду**.
- 🔒 Судьба статуса `frozen` (мапить/оставить).

_TODO(§6): значения порогов и политика ответа лида проставляются после решения бизнеса._
