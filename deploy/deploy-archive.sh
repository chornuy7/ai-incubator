#!/usr/bin/env bash
# Выкат БЕЗ git на сервере: код едет архивом с машины разработчика.
#
# Запускать ЛОКАЛЬНО:  bash deploy/deploy-archive.sh
#
# Почему не deploy.sh: на сервере /opt/ai-incubator — это НЕ git-репозиторий,
# `git pull` там невозможен. Код приезжает `git archive` + scp.
#
# Главное отличие от «просто распаковать поверх»: tar не удаляет файлы, которых
# в архиве нет. Файл, стёртый из репозитория, остаётся на сервере жить — и ломает
# сборку ссылкой на давно удалённый экспорт (выкат 14.08: `ApiKeysPanel.tsx`
# импортировал `issueApiKey`, которого в `adminApi` уже нет, и `tsc` валил билд).
# Поэтому после распаковки лишние файлы вычищаются по разнице с архивом.
set -euo pipefail

HOST="${HOST:-root@45.142.142.216}"
APP_DIR="${APP_DIR:-/opt/ai-incubator}"
REF="${REF:-HEAD}"

echo "→ Собираем архив из $REF"
git archive --format=tar "$REF" -o /tmp/deploy.tar
echo "→ Заливаем на $HOST"
scp -q /tmp/deploy.tar "$HOST:/tmp/deploy.tar"

ssh "$HOST" APP_DIR="$APP_DIR" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"

TS=$(date +%Y%m%d-%H%M%S)

# Данные (аккаунты, сессии, цели, кампании) живут в server/data и в архив не входят.
if [ -d server/data ]; then
  B="/var/backups/ai-incubator/data-$TS"
  mkdir -p "$B" && cp -r server/data/. "$B"/ 2>/dev/null || true
  echo "→ Бэкап данных: $B"
fi

echo "→ Распаковка"
tar xf /tmp/deploy.tar -C "$APP_DIR"

# Чистка хвостов от прошлых выкатов. Смотрим только каталоги с КОДОМ:
# server/data — состояние, node_modules и dist — генерируемые.
echo "→ Ищем файлы, удалённые из репозитория"
tar tf /tmp/deploy.tar | grep -v '/$' | sort > /tmp/in-archive.txt
find src server -type f 2>/dev/null | grep -v '^server/data/' | sort > /tmp/on-disk.txt
comm -13 /tmp/in-archive.txt /tmp/on-disk.txt > /tmp/stale.txt

STALE=$(wc -l < /tmp/stale.txt)
if [ "$STALE" -gt 0 ]; then
  S="/var/backups/ai-incubator/stale-$TS"
  # Не удаляем безвозвратно: если файл лежал не зря, его можно вернуть.
  while read -r f; do mkdir -p "$S/$(dirname "$f")"; cp "$f" "$S/$f"; rm -f "$f"; done < /tmp/stale.txt
  echo "→ Убрано лишних файлов: $STALE (копии в $S)"
  cat /tmp/stale.txt
else
  echo "→ Лишних файлов нет"
fi

echo "→ Зависимости и сборка"
npm ci --silent
npm run build 2>&1 | tail -3

echo "→ Перезапуск"
systemctl restart ai-incubator
# Старт занимает ~10 с (планировщики, кэш trust) — ждём, иначе health бьётся в закрытую дверь.
for i in $(seq 1 20); do
  sleep 1
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then break; fi
done
curl -fsS http://127.0.0.1:3001/api/health && echo "" && echo "✅ Выкат завершён"
REMOTE
