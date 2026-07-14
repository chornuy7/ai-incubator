---
name: security-review
description: Прогнать security review изменений (auth, IDOR, XSS, секреты, инъекции, SSRF). Вызывать по /security_review или /security-review.
---

# Security Review

Проведи тщательный security review изменений текущей ветки (`main...HEAD` + незакоммиченное).
Стек проекта: Node/Express (ESM) + GramJS (Telegram MTProto) + React/Vite; данные — JSON в `server/data/`.

## Объём

1. `git status` и `git diff --stat main...HEAD` — определить затронутые файлы.
2. Читать файлы с контекстом (не только строки diff).

## Чеклист

- **Секреты**: захардкоженные токены/пароли, `TELEGRAM_API_ID/HASH`, `OPENAI_API_KEY`, cookies TGStat; утечка `.env`/`.session`/`server/data/` в git (должны быть в `.gitignore`).
- **Auth/доступы**: dev-bypass и fail-open ветки; IDOR (нет проверки владельца); обход локов (`accountLocks`) и статус-гейта (`accountStatus`, `assertAccountsAssignable`) — «захват» чужого аккаунта.
- **Инъекции**: `child_process`, `eval`/`Function`, path traversal при работе с файлами и путями сессий.
- **SSRF**: TGStat-скрейпинг, пользовательские URL/прокси/инвайты — куда уходят данные.
- **XSS**: `dangerouslySetInnerHTML`, непроверенный HTML/Markdown, `href` из данных.
- **Парсинг**: `JSON.parse`/cheerio на недоверенном вводе, regex-DoS.
- **Логи/аудит**: секреты в логах; критичные действия в аудит (`auditLog`).
- **Rate limit/DoS**: незащищённые дорогие роуты (login, парсинг, экспорт).
- **Зависимости**: новые пакеты/версии с известными проблемами.

## Отчёт

Каждая находка: severity (critical/high/medium/low), `файл:строка`, суть, конкретный сценарий эксплуатации,
рекомендация. Сортировка от critical. Подтверждённое отделять от предположений. Чисто — сказать прямо.
Не выдумывать уязвимости ради объёма.

## Важно (из практики)

- Не коммитить и не запускать на prod QA-скрипты с hardcoded OTP / требованием bypass — это playground для старого OTP.
- В health-эндпоинте не отдавать `environment: development` на проде.
- Captcha/Turnstile: без ключей — не fail-open (не пропускать), а закрывать.
