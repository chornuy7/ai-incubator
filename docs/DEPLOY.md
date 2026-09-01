# Деплой на сервер (45.142.142.216)

> ## Как выкатываем сейчас (актуально с 14.08)
>
> На сервере `/opt/ai-incubator` — **не git-репозиторий**, поэтому `deploy/deploy.sh`
> (он тянет `git pull`) там не работает. Рабочий путь — архивом с локальной машины:
>
> ```bash
> bash deploy/deploy-archive.sh
> ```
>
> Скрипт: бэкап `server/data` → `git archive` + scp → распаковка → **чистка файлов,
> удалённых из репозитория** → `npm ci` → `npm run build` → рестарт → health.
>
> Про чистку отдельно: `tar` не удаляет то, чего в архиве нет. Файл, стёртый из репо,
> остаётся на сервере и однажды ломает сборку — 14.08 так и вышло: `ApiKeysPanel.tsx`
> импортировал `issueApiKey`, которого в `adminApi` уже нет, и `tsc` завалил билд, хотя
> локально всё было чисто. Удалённые файлы не стираются насовсем, а уезжают в
> `/var/backups/ai-incubator/stale-<дата>`.
>
> Разделы ниже описывают первичную настройку и остаются в силе; часть про
> basic auth в nginx устарела — пароль снят, вход по настоящей авторизации.

Панель поднимается одним Node-процессом (API + собранный фронт), наружу её выпускает
nginx на :80 **под паролем**. Заход — по IP сервера.

---

## ⚠️ Безопасность — прочитать до выката

Панель управляет **реальными Telegram-аккаунтами**. При этом:

- API **не требует авторизации**: `moduleAccessGuard` устроен fail-open — если нет заголовка
  `X-User-Id`, запрос **пропускается** (`server/lib/accessGuard.js`, дев-модель из `CONTRACT-rbac.md §7`);
- CORS открыт всем (`app.use(cors())`);
- в `server/data/sessions` лежат **живые сессии** аккаунтов — это полный доступ к ним;
- в `.env` — `TELEGRAM_API_HASH`, при желании `OPENAI_API_KEY`.

### `SECRETS_KEY` — обязателен на проде (MR-290)

Облачные пароли аккаунтов (2FA) хранятся в базе **зашифрованными**: ключ живёт в
окружении приложения, в базу не попадает. Без переменной сохранение пароля отказывает —
это сделано намеренно: положить ещё один пароль в общую базу открытым текстом хуже, чем
видимая ошибка при импорте. Сервер говорит об этом при старте, а не при первой записи.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Значение — в `.env` рядом с остальными секретами (и в секреты GitHub Actions, если выкат
идёт оттуда). **Ключ нельзя терять:** облачный пароль не прочитать в Telegram и неоткуда
восстановить, поэтому копия ключа обязана лежать во втором месте, и не на этом же сервере.

Шифруем в приложении, а не средствами базы, сознательно. В Postgres есть и `pgcrypto`, и
Supabase Vault, но Vault хранит ключ **в той же базе** и отдаёт расшифровку представлением
`vault.decrypted_secrets`, на которое у `service_role` есть `SELECT` — то есть доступ,
которым злоумышленник прочитал бы пароль, даёт ему и ключ. Vault остаётся уместен для
секретов, которые нужны самой базе (например, ключ для `pg_cron` + `pg_net`).

После первого выката с ключом один раз перенести старые секреты — сначала пароли, потом
сессии:

```bash
node --env-file=.env server/scripts/encrypt-secrets.mjs --dry
node --env-file=.env server/scripts/encrypt-secrets.mjs
node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs --dry
node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs
node --env-file=.env server/scripts/sessions-to-db.mjs --dry
node --env-file=.env server/scripts/sessions-to-db.mjs
```

Оба шифруют, читают обратно, сверяют — и только потом трогают исходник.

Файлы сессий скрипт по умолчанию **оставляет на месте**: пока не проверено, что панель
работает с базой, вторая копия лучше. Когда проверите — убрать их:

```bash
node --env-file=.env server/scripts/sessions-to-db.mjs --drop
```

До этого момента `server/data/sessions` остаётся тем, чем был, — каталогом с полным
доступом ко всем аккаунтам. Строчка выше про «живые сессии» перестаёт быть верной только
после `--drop`.

Отдельно — **задачи модулей**. Их переносят при ОСТАНОВЛЕННОМ сервере: пока воркеры
живы, они пишут в файлы, и перенос получится с обрывом на полуслове.

```bash
sudo systemctl stop ai-incubator
node --env-file=.env server/scripts/tasks-to-db.mjs --dry
node --env-file=.env server/scripts/tasks-to-db.mjs
sudo systemctl start ai-incubator
```

Файлы задач скрипт не удаляет. Убирать их — отдельным решением, когда станет видно, что
дашборд и возобновление работают из базы.

### Снос старых колонок — СЛЕДУЮЩИМ выпуском, не этим (MR-290)

Миграции применяются ДО деплоя кода, и между этими двумя моментами на сервере работает
предыдущая версия приложения — уже с новой схемой. Снести старую колонку тем же выпуском,
что и завести новую, значит дать предыдущей версии в это окно обращаться к колонке,
которой уже нет. Окно короткое, но в него панель управляет живыми аккаунтами.

Поэтому MR-290 колонки НЕ сносит: он заводит новые и пишет в оба места. Готовые сносы
лежат в `supabase/next-release/` — раннер туда не заходит, порядок и условия описаны в
README рядом.

Отдельно про `2026-09-03-mr290-drop-secrets.sql`: у него условие не «прошёл выпуск», а
«перенос секретов отработал». Он сносит открытые пароли, а облачный пароль 2FA неоткуда
восстановить — снос до переноса это не откат из бэкапа, а потеря доступа к аккаунтам.
Миграция сама проверяет, что открытых паролей не осталось, и отказывает, если они есть.

Поэтому в самом коде дефолт — слушать только `127.0.0.1` («без auth не должно торчать в интернет»).

**Вывод:** голым IP выставлять нельзя. Минимум на время тестов — **basic auth в nginx**
(в конфиге ниже уже включён). Дополнительно можно ограничить по IP (`allow/deny`) или файрволом.
Постоянное решение — заменить fail-open guard на нормальную сессию/токен (отдельная задача).

---

## Шаг 0. Дать доступ по SSH (сейчас блокирует)

Сервер отвечает, но наш ключ не авторизован (`Permission denied (publickey)`).
Присланный `ssh-ed25519 AAAA…NdUkIfRX83BSnQ5ogt5Rnjt3xkt41sFQZcPa6O+NdLs` — **публичный**,
подключиться по нему нельзя (нужна приватная половина, а её в чат слать не надо).

Правильный путь — добавить **наш публичный ключ** на сервер. Выполнить на сервере
(от того, у кого доступ есть):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINpF3qS42WBb4E85HQ+qnGDqwJAI7hwnk1kh7RP6Ewq9 aedobroskok@gmail.com' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Проверка с нашей стороны: `ssh root@45.142.142.216 'echo ok'`

---

## Шаг 1. Первичная настройка сервера (один раз)

```bash
ssh root@45.142.142.216

# Node 20 + nginx + утилиты
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx git apache2-utils

# Код
mkdir -p /opt && cd /opt
git clone <URL-репозитория> ai-incubator      # tor2026/Myrmex или chornuy7/ai-incubator
cd ai-incubator
git checkout feat/a-phase1-status-machine

# Секреты (НЕ в гите)
cp .env.example .env && nano .env
#   TELEGRAM_API_ID / TELEGRAM_API_HASH — обязательно
#   OPENAI_API_KEY — иначе ИИ-тексты будут шаблонными
#   API_PORT=3001, API_HOST=127.0.0.1

npm ci
npm run build          # соберёт dist/, Express отдаст его сам

# Сервис
cp deploy/ai-incubator.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-incubator
systemctl status ai-incubator --no-pager

# nginx + пароль
cp deploy/nginx-ai-incubator.conf /etc/nginx/sites-available/ai-incubator
ln -sf /etc/nginx/sites-available/ai-incubator /etc/nginx/sites-enabled/ai-incubator
rm -f /etc/nginx/sites-enabled/default
htpasswd -c /etc/nginx/.htpasswd incubator      # задать пароль
nginx -t && systemctl reload nginx
```

Готово — **http://45.142.142.216** (логин `incubator` + заданный пароль).

---

## Шаг 2. Последующие выкаты

```bash
ssh root@45.142.142.216 'bash /opt/ai-incubator/deploy/deploy.sh'
```

Скрипт: бэкапит `server/data` → `git pull` → `npm ci` → `npm run build` → рестарт сервиса →
проверка `/api/health`.

Переменные: `APP_DIR` (по умолчанию `/opt/ai-incubator`), `BRANCH`, `REMOTE`.

### Живая документация MCP на проде

Страница `/docs/mcp` (весь протокол глазами + выполнение запросов) на проде **выключена по
умолчанию**: `SESSION_SECRET` задан, а это инструмент разработчика — висеть открытым на
боевом домене ему незачем. Чтобы включить, добавь в env сервиса и перезапусти:

```
MCP_DOCS=1
```

Пока флага нет, `https://myrmexgram.ai/docs/mcp` отвечает текстом
«MCP docs are disabled on this deployment» — это не ошибка выката.

Политика использования данных (`/docs/mcp/policy`) от флага **не зависит** и открывается
всегда: на неё ссылаются метаданные ресурса, и по этой ссылке идёт клиент, только что
получивший 401.

Всё, что не `/api` и не зарегистрировано явно, перехватывает SPA-фолбэк и уводит на логин
или в панель — именно так выглядит опечатка в адресе, и по этому симптому её и опознают.
Реальные точки входа три (плюс редирект `/mcp-docs` → `/docs/mcp` со старого адреса):

| Путь | Что это | Нужен ключ |
|---|---|---|
| `POST /api/v1/mcp` | сам протокол (JSON-RPC 2.0) | да |
| `GET /docs/mcp` | живая документация | нет (ключ вводится на странице) |
| `GET /docs/mcp/policy` | политика использования данных (`resource_policy_uri`) | нет |
| `GET /.well-known/oauth-protected-resource/api/v1/mcp` | метаданные RFC 9728 | нет |

---

## Данные и рестарты

- Всё состояние — в `server/data/` (аккаунты, **сессии**, цели, кампании, задачи, прокси, роли).
  Каталог не в гите; `deploy.sh` бэкапит его в `/var/backups/ai-incubator/` перед каждым выкатом.
- Воркеры живут в памяти процесса: при рестарте running-задачи помечаются `stopped`
  (`reconcileStaleTasksOnBoot`) — это ожидаемое поведение, задачи нужно перезапустить.

## Диагностика

```bash
systemctl status ai-incubator          # состояние
journalctl -u ai-incubator -f          # логи приложения
curl http://127.0.0.1:3001/api/health  # API живой?
tail -f /var/log/nginx/ai-incubator.error.log
```

| Симптом | Причина |
|---|---|
| 502 в браузере | Node не запущен → `journalctl -u ai-incubator -n 50` |
| Открывается, но пустая страница | Не собран фронт → `npm run build` |
| 404 на прямой ссылке `/panel/tasks/:id` | Нет SPA-fallback → обновить код (добавлен в `server/index.js`) |
| Просит пароль повторно | Проверить `/etc/nginx/.htpasswd` |
