#!/usr/bin/env python3
"""
Прогон приватного API Murmex (§10.3) — /api/v1, доступ по закрытому ключу.

Зависимостей нет: только стандартная библиотека Python 3. Запуск:

    # ключ — сервисный «мозгов», задан в окружении сервера (MURMEX_API_KEY на бэкенде)
    export MURMEX_API_KEY="aii_live_sk_..."
    export MURMEX_BASE_URL="https://myrmexgram.ai"   # или http://localhost:3001
    python3 test_api_v1.py

Или короче (Windows PowerShell):
    $env:MURMEX_API_KEY="aii_live_sk_..."; python3 test_api_v1.py --base https://myrmexgram.ai

Что проверяется:
  1. /api/health                          — живой ли сервис
  2. /api/v1/capabilities без ключа        -> 401 (закрыто)
  3. /api/v1/capabilities с кривым ключом  -> 401
  4. /api/v1/me                            — от чьего имени работает ключ
  5. /api/v1/capabilities                  — что умеет каждый модуль
  6. /api/v1/mcp                           — MCP-манифест инструментов
  7. POST /api/v1/goals                    — создать цель
  8. GET  /api/v1/goals                    — созданная цель в списке
  9. POST /api/v1/campaigns                — создать кампанию под цель
  10. POST /api/v1/modules/<mod>/estimate  — оценка стоимости/времени
  11. POST /api/v1/modules/<mod>/run       — запуск (ТОЛЬКО с флагом --run: реальное действие!)

Скрипт НИЧЕГО не удаляет и не запускает боевых задач без явного --run.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

# Windows-консоль по умолчанию cp1251 — принудительно UTF-8, иначе кириллица/стрелки падают.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── маленький HTTP-клиент на stdlib ──────────────────────────────────────────

def request(method, url, token=None, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, _json(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, _json(raw)
    except urllib.error.URLError as e:
        return 0, {"error": f"нет соединения: {e.reason}"}


def _json(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw[:200]}


# ── раннер ───────────────────────────────────────────────────────────────────

class Runner:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name, cond, detail=""):
        mark = "PASS" if cond else "FAIL"
        if cond:
            self.passed += 1
        else:
            self.failed += 1
        line = f"  [{mark}] {name}"
        if detail:
            line += f"  — {detail}"
        print(line)
        return cond

    def summary(self):
        total = self.passed + self.failed
        print("\n" + "=" * 52)
        print(f"  Итог: {self.passed}/{total} прошло, {self.failed} упало")
        print("=" * 52)
        return self.failed == 0


def main():
    ap = argparse.ArgumentParser(description="Прогон приватного API Murmex /api/v1")
    ap.add_argument("--base", default=os.environ.get("MURMEX_BASE_URL", "https://myrmexgram.ai"),
                    help="Базовый адрес (по умолч. https://myrmexgram.ai или $MURMEX_BASE_URL)")
    ap.add_argument("--key", default=os.environ.get("MURMEX_API_KEY", ""),
                    help="API-ключ aii_live_sk_... (или $MURMEX_API_KEY)")
    ap.add_argument("--module", default="neuro-commenting", help="Модуль для estimate/run")
    ap.add_argument("--run", action="store_true",
                    help="Реально запустить модуль (РЕАЛЬНОЕ действие по аккаунтам!). Без флага — не запускает.")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    key = args.key.strip()
    api = f"{base}/api/v1"

    print(f"Сервер: {base}")
    print(f"Ключ:   {'задан ' + key[:16] + '…' if key else 'НЕ ЗАДАН'}\n")

    if not key:
        print("Нужен ключ: export MURMEX_API_KEY=aii_live_sk_... (или --key).")
        print("Ключ сервисный — задаётся в окружении сервера (MURMEX_API_KEY) и там же берётся.")
        print("Статус ключа виден в /admin → вкладка API.")
        sys.exit(2)

    r = Runner()

    # 1. health (публичный)
    st, b = request("GET", f"{base}/api/health")
    r.check("health отвечает", st == 200 and b.get("ok") is True, f"HTTP {st}")

    # 2-3. без ключа и с кривым — 401
    st, _ = request("GET", f"{api}/capabilities")
    r.check("без ключа -> 401", st == 401, f"HTTP {st}")
    st, _ = request("GET", f"{api}/capabilities", token="aii_live_sk_0000deadbeef0000")
    r.check("кривой ключ -> 401", st == 401, f"HTTP {st}")

    # 4. me — либо пользователь-владелец (email), либо системный ключ (service)
    st, b = request("GET", f"{api}/me", token=key)
    user = b.get("user") or {}
    who = user.get("email") or (user.get("id") if user.get("service") else "")
    r.check("me: 200 и есть личность ключа", st == 200 and bool(who),
            f"HTTP {st}, who={who or '—'}")

    # 5. capabilities
    st, b = request("GET", f"{api}/capabilities", token=key)
    mods = b.get("modules") or []
    r.check("capabilities: список модулей", st == 200 and len(mods) > 0, f"модулей: {len(mods)}")
    if mods:
        first = mods[0]
        r.check("у модуля есть ключ, цена, путь run",
                bool(first.get("key")) and "pricing" in first and "run" in first,
                f"пример: {first.get('key')}")

    # 6. mcp-манифест
    st, b = request("GET", f"{api}/mcp", token=key)
    tools = b.get("tools") or []
    names = {t.get("name") for t in tools}
    r.check("mcp: манифест инструментов", st == 200 and len(tools) > 0, f"инструментов: {len(tools)}")
    r.check("mcp: есть create_goal и whoami", {"create_goal", "whoami"} <= names,
            f"инструменты: {', '.join(sorted(n for n in names if n))[:80]}")

    # 7. создать цель
    goal_name = f"API-тест цель {int(time.time())}"
    st, b = request("POST", f"{api}/goals", token=key,
                    body={"name": goal_name, "metric": {"kind": "clicks", "target": 100}})
    goal = b.get("goal") or {}
    goal_id = goal.get("id", "")
    r.check("POST /goals: цель создана", st == 200 and goal_id.startswith("goal_"),
            f"HTTP {st}, id={goal_id or '—'}")

    # 8. цель в списке
    st, b = request("GET", f"{api}/goals", token=key)
    goals = b.get("goals") or []
    r.check("GET /goals: созданная цель в списке",
            any(g.get("id") == goal_id for g in goals) if goal_id else False,
            f"всего целей: {len(goals)}")

    # 9. создать кампанию под цель
    if goal_id:
        st, b = request("POST", f"{api}/campaigns", token=key,
                        body={"name": f"API-тест кампания {int(time.time())}",
                              "modules": [args.module], "goalId": goal_id})
        camp = b.get("campaign") or {}
        r.check("POST /campaigns: кампания создана",
                st == 200 and str(camp.get("id", "")).startswith("cmp") or bool(camp.get("id")),
                f"HTTP {st}, id={camp.get('id', '—')}")

    # 10. estimate
    st, b = request("POST", f"{api}/modules/{args.module}/estimate", token=key,
                    body={"actions": 100, "accounts": 5})
    cost = (b.get("cost") or {})
    r.check(f"estimate {args.module}: цена и время",
            st == 200 and "actionsCoins" in cost and "time" in b,
            f"HTTP {st}, ~{cost.get('actionsCoins', '?')} {cost.get('currency', '')}")

    # 11. run — только с флагом (реальное действие)
    if args.run:
        st, b = request("POST", f"{api}/modules/{args.module}/run", token=key,
                        body={"accountIds": [], "targets": ["@ai_incubator_test"], "maxActions": 1})
        # Ожидаемо упрёмся в accountIds/доступ — проверяем, что ответ осмысленный (не 500).
        r.check("run: осмысленный ответ (не 500)", st in (200, 400, 403),
                f"HTTP {st}, {b.get('error') or b.get('taskId') or ''}")
    else:
        print("  [skip] run — реальный запуск модуля (передайте --run, если нужно)")

    ok = r.summary()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
