// Ukrainian (default) locale dictionary for FINMAN.
// Registered onto window.FINMAN_LOCALES.uk.
(function (root) {
  'use strict';
  var dict = {
    // ---- app ----
    'app.name': 'ФінМенеджер',
    'app.tagline': 'Персональний фінансовий менеджер',
    'app.loading': 'Завантаження застосунку...',

    // ---- navigation ----
    'nav.dashboard': 'Огляд',
    'nav.accounts': 'Рахунки',
    'nav.transactions': 'Транзакції',
    'nav.budgets': 'Бюджети',
    'nav.goals': 'Цілі',
    'nav.debts': 'Борги',
    'nav.investments': 'Інвестиції',
    'nav.analytics': 'Аналітика',
    'nav.reports': 'Звіти',
    'nav.subscriptions': 'Підписки',
    'nav.networth': 'Чистий капітал',
    'nav.receipts': 'Чеки',
    'nav.calendar': 'Календар',
    'nav.forecast': 'Прогноз',
    'nav.family': 'Сім’я',
    'nav.recurring': 'Регулярні',
    'nav.settings': 'Налаштування',
    'nav.assistant': 'AI-асистент',

    // ---- buttons / actions ----
    'btn.add': 'Додати',
    'btn.create': 'Створити',
    'btn.save': 'Зберегти',
    'btn.edit': 'Редагувати',
    'btn.delete': 'Видалити',
    'btn.cancel': 'Скасувати',
    'btn.close': 'Закрити',
    'btn.confirm': 'Підтвердити',
    'btn.back': 'Назад',
    'btn.next': 'Далі',
    'btn.search': 'Пошук',
    'btn.filter': 'Фільтр',
    'btn.export': 'Експорт',
    'btn.import': 'Імпорт',
    'btn.refresh': 'Оновити',
    'btn.upgrade': 'Покращити',
    'btn.login': 'Увійти',
    'btn.logout': 'Вийти',
    'btn.register': 'Зареєструватися',

    // ---- common labels ----
    'common.name': 'Назва',
    'common.amount': 'Сума',
    'common.currency': 'Валюта',
    'common.date': 'Дата',
    'common.category': 'Категорія',
    'common.description': 'Опис',
    'common.type': 'Тип',
    'common.status': 'Статус',
    'common.balance': 'Баланс',
    'common.total': 'Усього',
    'common.income': 'Дохід',
    'common.expense': 'Витрата',
    'common.from': 'З',
    'common.to': 'До',
    'common.actions': 'Дії',
    'common.optional': 'Необов’язково',
    'common.required': 'Обов’язково',
    'common.yes': 'Так',
    'common.no': 'Ні',
    'common.all': 'Усі',
    'common.none': 'Немає',
    'common.loading': 'Завантаження...',
    'common.saving': 'Збереження...',
    'common.empty': 'Немає даних',
    'common.email': 'Ел. пошта',
    'common.password': 'Пароль',
    'common.fullName': 'Повне ім’я',
    'common.progress': 'Прогрес',
    'common.remaining': 'Залишилось',
    'common.target': 'Ціль',

    // ---- messages ----
    'msg.saved': 'Успішно збережено',
    'msg.deleted': 'Видалено',
    'msg.created': 'Створено',
    'msg.updated': 'Оновлено',
    'msg.error': 'Сталася помилка',
    'msg.loadError': 'Не вдалося завантажити дані',
    'msg.confirmDelete': 'Видалити цей запис?',
    'msg.unauthorized': 'Не авторизовано',
    'msg.notConfigured': 'Не налаштовано',
    'msg.greeting': 'Вітаємо, {name}!',
    'msg.itemsCount': 'Записів: {count}'
  };

  root.FINMAN_LOCALES = root.FINMAN_LOCALES || {};
  root.FINMAN_LOCALES.uk = dict;

  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
