// Russian locale dictionary for FINMAN.
// Registered onto window.FINMAN_LOCALES.ru.
(function (root) {
  'use strict';
  var dict = {
    // ---- app ----
    'app.name': 'ФинМенеджер',
    'app.tagline': 'Персональный финансовый менеджер',
    'app.loading': 'Загрузка приложения...',

    // ---- navigation ----
    'nav.dashboard': 'Обзор',
    'nav.accounts': 'Счета',
    'nav.transactions': 'Транзакции',
    'nav.budgets': 'Бюджеты',
    'nav.goals': 'Цели',
    'nav.debts': 'Долги',
    'nav.investments': 'Инвестиции',
    'nav.analytics': 'Аналитика',
    'nav.reports': 'Отчёты',
    'nav.subscriptions': 'Подписки',
    'nav.networth': 'Чистый капитал',
    'nav.receipts': 'Чеки',
    'nav.calendar': 'Календарь',
    'nav.forecast': 'Прогноз',
    'nav.family': 'Семья',
    'nav.recurring': 'Регулярные',
    'nav.settings': 'Настройки',
    'nav.assistant': 'AI-ассистент',

    // ---- buttons / actions ----
    'btn.add': 'Добавить',
    'btn.create': 'Создать',
    'btn.save': 'Сохранить',
    'btn.edit': 'Редактировать',
    'btn.delete': 'Удалить',
    'btn.cancel': 'Отмена',
    'btn.close': 'Закрыть',
    'btn.confirm': 'Подтвердить',
    'btn.back': 'Назад',
    'btn.next': 'Далее',
    'btn.search': 'Поиск',
    'btn.filter': 'Фильтр',
    'btn.export': 'Экспорт',
    'btn.import': 'Импорт',
    'btn.refresh': 'Обновить',
    'btn.upgrade': 'Улучшить',
    'btn.login': 'Войти',
    'btn.logout': 'Выйти',
    'btn.register': 'Зарегистрироваться',

    // ---- common labels ----
    'common.name': 'Название',
    'common.amount': 'Сумма',
    'common.currency': 'Валюта',
    'common.date': 'Дата',
    'common.category': 'Категория',
    'common.description': 'Описание',
    'common.type': 'Тип',
    'common.status': 'Статус',
    'common.balance': 'Баланс',
    'common.total': 'Итого',
    'common.income': 'Доход',
    'common.expense': 'Расход',
    'common.from': 'С',
    'common.to': 'По',
    'common.actions': 'Действия',
    'common.optional': 'Необязательно',
    'common.required': 'Обязательно',
    'common.yes': 'Да',
    'common.no': 'Нет',
    'common.all': 'Все',
    'common.none': 'Нет',
    'common.loading': 'Загрузка...',
    'common.saving': 'Сохранение...',
    'common.empty': 'Нет данных',
    'common.email': 'Эл. почта',
    'common.password': 'Пароль',
    'common.fullName': 'Полное имя',
    'common.progress': 'Прогресс',
    'common.remaining': 'Осталось',
    'common.target': 'Цель',

    // ---- messages ----
    'msg.saved': 'Успешно сохранено',
    'msg.deleted': 'Удалено',
    'msg.created': 'Создано',
    'msg.updated': 'Обновлено',
    'msg.error': 'Произошла ошибка',
    'msg.loadError': 'Не удалось загрузить данные',
    'msg.confirmDelete': 'Удалить эту запись?',
    'msg.unauthorized': 'Не авторизован',
    'msg.notConfigured': 'Не настроено',
    'msg.greeting': 'Здравствуйте, {name}!',
    'msg.itemsCount': 'Записей: {count}'
  };

  root.FINMAN_LOCALES = root.FINMAN_LOCALES || {};
  root.FINMAN_LOCALES.ru = dict;

  if (typeof module !== 'undefined' && module.exports) module.exports = dict;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
