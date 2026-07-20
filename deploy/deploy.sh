#!/usr/bin/env bash
# Деплой AI Incubator на сервер: подтянуть код → собрать фронт → перезапустить сервис.
# Запускать НА СЕРВЕРЕ:  bash /opt/ai-incubator/deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-incubator}"
BRANCH="${BRANCH:-feat/a-phase1-status-machine}"
REMOTE="${REMOTE:-origin}"

echo "→ Каталог: $APP_DIR (ветка $BRANCH)"
cd "$APP_DIR"

# Данные (аккаунты, сессии, цели, кампании) лежат в server/data и НЕ должны теряться.
if [ -d server/data ]; then
  BACKUP="/var/backups/ai-incubator/data-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  cp -r server/data/. "$BACKUP"/ 2>/dev/null || true
  echo "→ Бэкап данных: $BACKUP"
fi

echo "→ Забираем код"
git fetch "$REMOTE" --prune
git checkout "$BRANCH"
git pull --ff-only "$REMOTE" "$BRANCH"

echo "→ Зависимости"
npm ci

echo "→ Сборка фронта (dist/)"
npm run build

echo "→ Перезапуск сервиса"
sudo systemctl restart ai-incubator
sleep 2
sudo systemctl --no-pager --lines=10 status ai-incubator || true

echo "→ Проверка API"
curl -fsS http://127.0.0.1:3001/api/health && echo "" && echo "✅ Деплой завершён"
