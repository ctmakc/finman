# Finman — Handoff 2026-05-15

## Что сделано за последние две сессии (автономный спринт)

### Баги в колонках БД (было 5 мест с неверными именами)
| Файл | Было | Стало |
|---|---|---|
| `routes/calendar.js` | `next_execution_date`, `description as title` | `next_payment_date`, `name as title` |
| `routes/forecast.js` | `next_execution_date`, `goal_contributions.date`, `debt_payments.date` | правильные имена |
| `routes/widgets.js` | `next_execution_date`, `description as title` | правильные имена |

### Логические баги
- **Budget widget показывал устаревшие данные** — теперь вызывает `Budget.recalculateSpent()` перед отображением
- **`Debt.addPayment()` игнорировал `payment_date`** — параметр тихо терялся, все платежи записывались датой "сегодня"
- **Receipts `/stats/summary` возвращал неверные поля** — фронт ждал `total/processed/pending/totalAmount`, API отдавал `totalReceipts/pendingReceipts/thisMonthTotal` → пустые карточки + краш `undefined.toLocaleString()`

### Атомарность БД
- `routes/receipts.js` create-transaction — 3 операции (INSERT tx, UPDATE balance, UPDATE receipt) обёрнуты в BEGIN/COMMIT/ROLLBACK

### Краш (критический)
- **`family.js`** вызывал `escapeHtml()` в 9 местах, функция нигде не определена → `ReferenceError` на каждом рендере страницы семьи. Заменено на `esc()`.

### XSS (14 файлов)
Все шаблонные строки с пользовательскими данными в `innerHTML` теперь обёрнуты в `esc()`. Особо опасные случаи:
- `color`-поля в `style=` атрибутах (subscriptions, calendar, currency) — позволяли вырваться из атрибута через `"` и добавить `onclick=`
- `payment.description` в `<textarea>` (recurring.js) — позволял закрыть тег и внедрить скрипт
- `transaction.account_name`, `t.date`, `g.target_date`, `d.due_date`, `p.currency` и др.

### Service Worker
- Кеш поднят с `finman-v13` → `finman-v14` → `finman-v15` (два спринта)

---

## Состояние репозитория

```
Ветка: main
Последний коммит: a336d75 (bump SW cache v15)
Всего коммитов за спринт: ~24
```

## Что НЕ сделано / следующие шаги

1. **Деплой** — сервер не запускался, всё только на уровне кода
2. **Smoke test** — проверить в браузере: receipts stats, family page, calendar, recurring modal (edit), budget widget на dashboard
3. **Feature work** — можно добавлять: экспорт PDF, push-уведомления, реальный OCR через vision API (заглушка есть в `routes/ai.js`)
4. **Migrate to /data/projects** — файлы лежат в `/data/projects/_from-home-ecryptfs/finman` (симлинк `/data/projects/finman`)

## Ключевые пути

```
Проект:    /data/projects/_from-home-ecryptfs/finman/
GitHub:    https://github.com/ctmakc/finman
База:      ./data/finman.db (SQLite)
Запуск:    node server.js (или npm start)
Auth:      JWT via passport, секрет в config/config.js
```
