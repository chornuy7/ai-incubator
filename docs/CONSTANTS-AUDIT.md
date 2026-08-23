# Аудит констант в коде

Собран скриптом `scripts/audit-constants.mjs`. Повторить: `node scripts/audit-constants.mjs --md`.

Просьба с созвона 19.08: показать все константы — где лежат, зачем нужны, есть ли в базе.
Повод: цены собирались из значений, вписанных в файлы, и понять, откуда берётся сумма,
было нельзя.

Найдено **498** констант: **49** похожи на бизнес-значения
(деньги, лимиты, сроки, проценты), **449** — техника (таймауты, ключи, пути,
размеры), и ей в коде самое место.

## Бизнес-значения — проверить каждое

Правило простое: если значение решает, сколько человек платит или сколько ему можно, —
оно живёт в базе, а в коде остаётся только запасной вариант для дев-режима и тестов.

### Деньги (12) — только из базы

| Константа | Значение | Где | Что рядом написано в коде |
|---|---|---|---|
| `COIN_PRECISION` | `1000` | [server/balance.js:360](../server/balance.js#L360) | нельзя: каждое мелкое списание молча дорожает. |
| `PLANS` | `{` | [server/balance.js:46](../server/balance.js#L46) | набор — это выбор клиента, а не одна из трёх заготовок. |
| `INPUT_SHARE` | `0.75` | [server/lib/modelPricing.js:31](../server/lib/modelPricing.js#L31) | константой — если структура запросов изменится, правится одним числом. |
| `MODEL_PRICES_PER_1M` | `{` | [server/lib/modelPricing.js:15](../server/lib/modelPricing.js#L15) | — |
| `ACTION_PRICE` | `{` | [server/pricing.js:24](../server/pricing.js#L24) | — |
| `ANNUAL_DISCOUNT` | `0.2` | [server/pricing.js:164](../server/pricing.js#L164) | отсюда, иначе годовой план продаётся по одной цене, а в базу оплат пишется другая. |
| `COIN_PACKS` | `[` | [server/pricing.js:110](../server/pricing.js#L110) | `best` — что подсветить как выгодное: у крупных пакетов цена монеты ниже. |
| `MODULE_MONTH_PRICE` | `{` | [server/pricing.js:72](../server/pricing.js#L72) | ЦИФРЫ ВРЕМЕННЫЕ — прайс утверждает заказчик. Ориентир из разговора: ~20 $ за модуль. |
| `COINS_PER_1K_TOKENS` | `1` | [server/tokenLedger.js:33](../server/tokenLedger.js#L33) | Раньше это был «курс coinsPer1kTokens» из админки — убран как выдуманное значение (созвон 19.08). |
| `ANNUAL_DISCOUNT` | `0.2` | [src/pages/landing/catalog.ts:11](../src/pages/landing/catalog.ts#L11) | помесячный). Одно число, чтобы бизнес правил в одном месте. |
| `BONUS_MODULE` | `{` | [src/pages/landing/catalog.ts:169](../src/pages/landing/catalog.ts#L169) | — |
| `HEALTHY_COINS` | `500` | [src/widgets/AppHeader.tsx:21](../src/widgets/AppHeader.tsx#L21) | Порог назвал заказчик: «больше 500 токенов пусть оно становится зелёным». |

### Правила работы (37) — решить по каждому

Не деньги, но владелец рано или поздно захочет крутить их сам: пороги доверия, лимиты
безопасности, сроки. Пока в коде — значит меняются только выкатом.

| Константа | Значение | Где | Что рядом написано в коде |
|---|---|---|---|
| `TRUST_GATED_MODULES` | `new Set(['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-` | [server/accountsMeta.js:21](../server/accountsMeta.js#L21) | (§6: авто-стоп → прогрев). Прогрев/парсинг/просмотр/автопостинг в своих каналах — не гейтим. |
| `TRUST_MIN` | `40` | [server/accountsMeta.js:22](../server/accountsMeta.js#L22) | — |
| `DEADLINE_MAX_YEAR` | `new Date().getFullYear() + 20` | [server/campaigns.js:69](../server/campaigns.js#L69) | — |
| `DEADLINE_MIN_YEAR` | `2000` | [server/campaigns.js:68](../server/campaigns.js#L68) | — |
| `FOLLOW_UP_DEFAULT` | `10` | [server/campaigns.js:65](../server/campaigns.js#L65) | — |
| `FOLLOW_UP_MAX` | `50` | [server/campaigns.js:64](../server/campaigns.js#L64) | — |
| `DEADLINE_MAX_YEAR` | `new Date().getFullYear() + 20` | [server/goals.js:51](../server/goals.js#L51) | — |
| `DEADLINE_MIN_YEAR` | `2000` | [server/goals.js:50](../server/goals.js#L50) | — |
| `LEAD_TARGET_MAX` | `1_000_000` | [server/goals.js:54](../server/goals.js#L54) | — |
| `MAX_DEPTH` | `4` | [server/lib/accountScan.js:15](../server/lib/accountScan.js#L15) | — |
| `MAX_PARALLEL_CHATS` | `2` | [server/lib/antiCluster.js:14](../server/lib/antiCluster.js#L14) | — |
| `MAX_PER_PROXY_BURST` | `2` | [server/lib/antiCluster.js:20](../server/lib/antiCluster.js#L20) | выходит с одного IP в одну минуту — это и есть паттерн, по которому банят волной. |
| `PAGE_TEXT_MAX` | `8000` | [server/lib/pageFetch.js:15](../server/lib/pageFetch.js#L15) | — |
| `MIN_JOIN_DELAY_SEC` | `60` | [server/lib/protection.js:28](../server/lib/protection.js#L28) | Ускорять всё остальное можно, вступления — нет. |
| `DAILY_LIMITS` | `{` | [server/lib/safetyLimits.js:8](../server/lib/safetyLimits.js#L8) | — |
| `MAX_BOOT_RESUMES` | `3` | [server/lib/taskRecovery.js:25](../server/lib/taskRecovery.js#L25) | процесс, без потолка мы будем перезапускать её вечно и падать снова и снова. |
| `MIN_BY_PROTECTION_LEVEL` | `[60, 45, 30]` | [server/lib/workModeDuration.js:8](../server/lib/workModeDuration.js#L8) | => aggressive protectionLevel => min=30; UI durationMinutes=100 => period 30..100. |
| `MAX_TEXT` | `Math.max(0, Number(process.env.MESSAGES_MAX_TEXT) || 0)` | [server/messages.js:23](../server/messages.js#L23) | — |
| `ADMIN_RIGHTS_ERRORS` | `/CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|CHAT_SEND_.*FORBIDDEN|USER_B` | [server/modules/workers.js:3153](../server/modules/workers.js#L3153) | — |
| `THUMB_MAX_ENTRIES` | `300` | [server/neuroDialogs/service.js:86](../server/neuroDialogs/service.js#L86) | — |
| `PERIOD_LIMITS` | `{ week: 4, month: 6, year: 5 }` | [server/priceStore.js:45](../server/priceStore.js#L45) | прямо со звонка), скидка 0–90%. Мусор молча отбрасываем, дубли схлопываем. |
| `MONTH_DAYS` | `30` | [server/pricing.js:217](../server/pricing.js#L217) | — |
| `ADMIN_ROLE_ID` | `'role_admin'` | [server/roles.js:47](../server/roles.js#L47) | — |
| `FOLLOW_UP_DEFAULT` | `10` | [src/api/agentsApi.ts:46](../src/api/agentsApi.ts#L46) | — |
| `FOLLOW_UP_MAX` | `50` | [src/api/agentsApi.ts:45](../src/api/agentsApi.ts#L45) | — |
| `FOLLOW_UP_DEFAULT` | `10` | [src/api/campaignsApi.ts:127](../src/api/campaignsApi.ts#L127) | — |
| `FOLLOW_UP_MAX` | `50` | [src/api/campaignsApi.ts:126](../src/api/campaignsApi.ts#L126) | — |
| `DEADLINE_MAX_YEAR` | `new Date().getFullYear() + 20` | [src/api/goalsApi.ts:97](../src/api/goalsApi.ts#L97) | — |
| `DEADLINE_MIN_YEAR` | `2000` | [src/api/goalsApi.ts:96](../src/api/goalsApi.ts#L96) | — |
| `FOLLOW_UP_DEFAULT` | `10` | [src/api/goalsApi.ts:93](../src/api/goalsApi.ts#L93) | — |
| `FOLLOW_UP_MAX` | `50` | [src/api/goalsApi.ts:92](../src/api/goalsApi.ts#L92) | — |
| `LEAD_TARGET_MAX` | `1_000_000` | [src/api/goalsApi.ts:99](../src/api/goalsApi.ts#L99) | — |
| `DURATION_MIN_BY_PROTECTION_LEVEL` | `[60, 45, 30]` | [src/features/modules/LiveModule.tsx:44](../src/features/modules/LiveModule.tsx#L44) | — |
| `NEEDS_TARGETS` | `new Set([` | [src/pages/AutomationPage.tsx:23](../src/pages/AutomationPage.tsx#L23) | Модули, которым нужны цели (каналы/группы/номера) — server MODULE_DEFS.requiresTargets. |
| `TARGETS` | `{` | [src/pages/landing/ModuleMockScreen.tsx:13](../src/pages/landing/ModuleMockScreen.tsx#L13) | — |
| `TARGET_POOL` | `[` | [src/pages/ModuleRunner.tsx:45](../src/pages/ModuleRunner.tsx#L45) | — |
| `ADMIN_BYPASS_ID` | `'role_admin'` | [src/shared/config/rbac.ts:4](../src/shared/config/rbac.ts#L4) | — |

## Разбор денежных констант

Проверено вручную, чтобы список не читался как «всё плохо»:

- `MODULE_MONTH_PRICE`, `ACTION_PRICE`, `COIN_PACKS`, `ANNUAL_DISCOUNT`,
  `MODEL_PRICES_PER_1M` — запасные значения для дев-режима и тестов. В рабочем режиме
  не читаются: цены приходят из `module_prices`, `price_overrides`, `setups`,
  `model_prices`. Проверяется прогоном: ни один модуль не остаётся без цены из базы.
- `INPUT_SHARE = 0.75` — бывшая догадка «75/25». Сейчас доля входящих токенов считается
  по факту из журнала расхода, константа осталась запасным вариантом.
- `COINS_PER_1K_TOKENS = 1` — остаток формулы, которую убрали (созвон 19.08: «этого
  значения не должно существовать»). В списании не участвует, ни в одном экране не
  показывается. Мёртвый вес: считается `tokenCoins`, который нигде не выводится.
  Убрать вместе с колонкой `coins` в журнале расхода ИИ — отдельной правкой.
- `ANNUAL_DISCOUNT` на лендинге — запасной вариант, если периоды не пришли из админки.
  Живой скидкой не является, но лучше показывать один месяц, чем придуманные 20%.
- `PLANS`, `COIN_PRECISION`, `HEALTHY_COINS`, `BONUS_MODULE` — не цены:
  тариф-заглушка, точность округления монет, порог «мало токенов» в шапке и ключ
  бонусного модуля на лендинге.

## Техника — оставляем в коде

449 штук: таймауты сети, размеры буферов, ключи хранилищ, пути к файлам,
регулярные выражения, версии схем. Выносить их в базу незачем — они не про деньги и не
про правила, а про то, как работает сам код.
