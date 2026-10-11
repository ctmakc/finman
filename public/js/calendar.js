// Calendar Module
// Event amounts are shown in the event's own currency when the API provides
// one; otherwise as a plain number (no invented symbol). Modals use the
// shared hidden / is-open convention (lib/ui.js).
const CalendarModule = {
  events: [],
  currentDate: new Date(),
  view: 'month',
  typeIcons: { payment: 'fa-credit-card', income: 'fa-sack-dollar', reminder: 'fa-bell', goal: 'fa-bullseye', debt: 'fa-file-invoice', subscription: 'fa-box', recurring: 'fa-rotate' },

  icon(type) {
    return `<i class="fas ${this.typeIcons[type] || 'fa-calendar'}"></i>`;
  },

  // BCP-47 locale for Intl, derived from the active UI language.
  locale() {
    const lang = (typeof i18n !== 'undefined' && i18n.getLanguage) ? i18n.getLanguage() : 'en';
    return lang === 'uk' ? 'uk-UA' : lang === 'ru' ? 'ru-RU' : 'en-CA';
  },

  headers() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  amount(e) {
    if (e == null || e.amount == null || e.amount === '') return '';
    return UI.esc(e.currency ? UI.money(e.amount, e.currency) : UI.fmtNumber(e.amount));
  },

  safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#5D5CDE';
  },

  async init() {
    await UI.loadBaseCurrency();
    await this.loadEvents();
  },

  async loadEvents() {
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const start = new Date(year, month, 1).toISOString().split('T')[0];
    const end = new Date(year, month + 1, 0).toISOString().split('T')[0];

    try {
      const response = await fetch(`/api/calendar/events?start=${start}&end=${end}`, { headers: this.headers() });
      const data = await response.json();
      // Ошибка API не должна оставлять сетку пустой: рисуем месяц без событий.
      this.events = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      if (!Array.isArray(data) && !(data && Array.isArray(data.data))) console.error('calendar events:', data);
    } catch (error) {
      console.error('Error loading events:', error);
      this.events = [];
    }
    this.render();
  },

  render() {
    const container = document.getElementById('calendar-grid');
    if (!container) return;

    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date().toISOString().split('T')[0];

    const loc = this.locale();
    let title;
    try {
      title = new Date(year, month, 1).toLocaleDateString(loc, { month: 'long', year: 'numeric' });
    } catch (e) {
      title = `${year}-${String(month + 1).padStart(2, '0')}`;
    }
    document.getElementById('calendar-title').textContent = title.charAt(0).toUpperCase() + title.slice(1);

    // Monday-first weekday headers from Intl (2024-01-01 is a Monday).
    const weekdays = [];
    for (let i = 0; i < 7; i++) {
      try {
        weekdays.push(new Date(2024, 0, 1 + i).toLocaleDateString(loc, { weekday: 'short' }));
      } catch (e) {
        weekdays.push(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][i]);
      }
    }
    let html = '<div class="calendar-header-row">' + weekdays.map((d) => `<span>${UI.esc(d)}</span>`).join('') + '</div>';
    html += '<div class="calendar-days">';

    const startDay = firstDay === 0 ? 6 : firstDay - 1;
    for (let i = 0; i < startDay; i++) {
      html += '<div class="calendar-day empty"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayEvents = this.events.filter(e => e.event_date === dateStr);
      const isToday = dateStr === today;

      html += `<div class="calendar-day ${isToday ? 'today' : ''} ${dayEvents.length ? 'has-events' : ''}" data-action="cal:day" data-date="${dateStr}" role="button" tabindex="0" aria-label="${dateStr}${dayEvents.length ? ', ' + t('calendar.eventsCount', { n: dayEvents.length }) : ''}">
        <span class="day-number">${day}</span>
        ${dayEvents.slice(0, 3).map(e => `<div class="event-dot" style="background:${this.safeColor(e.color)}" title="${UI.esc(e.title)}"></div>`).join('')}
        ${dayEvents.length > 3 ? `<small>+${dayEvents.length - 3}</small>` : ''}
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    this.renderUpcoming();
  },

  async renderUpcoming() {
    const container = document.getElementById('upcoming-events');
    if (!container) return;

    try {
      const response = await fetch('/api/calendar/upcoming', { headers: this.headers() });
      const data = await response.json();
      const upcoming = Array.isArray(data) ? data : [];

      if (upcoming.length === 0) {
        container.innerHTML = `<p class="text-secondary">${t('calendar.noUpcoming')}</p>`;
        return;
      }

      container.innerHTML = upcoming.map(e => `
        <div class="upcoming-item" style="border-left: 3px solid ${this.safeColor(e.color)}">
          <span class="event-icon">${this.icon(e.event_type)}</span>
          <div class="event-info"><strong>${UI.esc(e.title)}</strong><small>${UI.esc(e.event_date)}</small></div>
          ${e.amount ? `<span class="event-amount">${this.amount(e)}</span>` : ''}
        </div>
      `).join('');
    } catch (error) {
      console.error('Error loading upcoming:', error);
    }
  },

  prevMonth() {
    this.currentDate.setMonth(this.currentDate.getMonth() - 1);
    this.loadEvents();
  },

  nextMonth() {
    this.currentDate.setMonth(this.currentDate.getMonth() + 1);
    this.loadEvents();
  },

  goToday() {
    this.currentDate = new Date();
    this.loadEvents();
  },

  showDayEvents(dateStr) {
    const dayEvents = this.events.filter(e => e.event_date === dateStr);

    document.getElementById('day-events-date').textContent = dateStr;
    document.getElementById('day-events-list').innerHTML = dayEvents.length === 0
      ? `<p class="text-secondary">${t('calendar.noEvents')}</p><button type="button" class="btn btn-sm btn-primary" data-action="cal:add" data-date="${dateStr}"><i class="fas fa-plus"></i> ${t('calendar.addForDay')}</button>`
      : dayEvents.map(e => `
        <div class="day-event-item">
          <span>${this.icon(e.event_type)}</span>
          <div><strong>${UI.esc(e.title)}</strong>${e.amount ? ` - ${this.amount(e)}` : ''}<br><small>${UI.esc(e.description || e.event_type)}</small></div>
          ${e.source ? '' : `<button type="button" class="btn btn-sm btn-icon" data-action="cal:complete" data-id="${e.id}" aria-label="${t('calendar.markDone')}" title="${t('calendar.done')}"><i class="fas fa-check"></i></button>`}
        </div>
      `).join('');

    UI.openModal('day-modal');
  },

  showAddModal(dateStr) {
    document.getElementById('event-form').reset();
    document.getElementById('event-date').value = dateStr || new Date().toISOString().split('T')[0];
    const cur = document.getElementById('event-currency');
    if (cur) cur.innerHTML = UI.currencyOptions();
    UI.openModal('event-modal');
  },

  async saveEvent() {
    const amountRaw = document.getElementById('event-amount').value;
    const data = {
      title: document.getElementById('event-title').value,
      event_type: document.getElementById('event-type').value,
      event_date: document.getElementById('event-date').value,
      amount: amountRaw ? parseFloat(amountRaw) : null,
      currency: document.getElementById('event-currency').value,
      description: document.getElementById('event-description').value,
      color: document.getElementById('event-color').value
    };

    try {
      await fetch('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(data)
      });
      UI.closeModal('event-modal');
      await this.loadEvents();
    } catch (error) {
      alert(t('msg.error'));
    }
  },

  async completeEvent(id) {
    try {
      await fetch(`/api/calendar/events/${Number(id)}/complete`, { method: 'POST', headers: this.headers() });
      await this.loadEvents();
      UI.closeModal('day-modal');
    } catch (error) {
      alert(t('msg.error'));
    }
  },

  getPage() {
    return `
      <div class="calendar-page">
        <div class="page-header"><h1>${t('calendar.title')}</h1>
          <button type="button" class="btn btn-primary" data-action="cal:add"><i class="fas fa-plus"></i> ${t('calendar.addEvent')}</button>
        </div>
        <div class="calendar-container card">
          <div class="calendar-nav">
            <button type="button" class="btn btn-icon" data-action="cal:prev" aria-label="${t('calendar.prevMonth')}"><i class="fas fa-chevron-left"></i></button>
            <h2 id="calendar-title"></h2>
            <button type="button" class="btn btn-icon" data-action="cal:next" aria-label="${t('calendar.nextMonth')}"><i class="fas fa-chevron-right"></i></button>
            <button type="button" class="btn btn-sm" data-action="cal:today">${t('calendar.today')}</button>
          </div>
          <div id="calendar-grid"></div>
        </div>
        <div class="card"><h3>${t('calendar.upcoming')}</h3><div id="upcoming-events"></div></div>
      </div>
      <div class="modal-backdrop" id="day-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title">${t('calendar.events')} <span id="day-events-date"></span></h2><button type="button" class="modal-close" data-action="ui:close" aria-label="${t('btn.close')}">&times;</button></div>
          <div class="modal-body" id="day-events-list"></div>
        </div>
      </div>
      <div class="modal-backdrop" id="event-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title">${t('calendar.newEvent')}</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="${t('btn.close')}">&times;</button></div>
          <div class="modal-body">
            <form id="event-form" data-submit="cal:save">
              <div class="form-group"><label for="event-title">${t('common.name')}</label><input type="text" id="event-title" class="form-control" required></div>
              <div class="form-row">
                <div class="form-group"><label for="event-type">${t('common.type')}</label><select id="event-type" class="form-control"><option value="payment">${t('calendar.type.payment')}</option><option value="income">${t('common.income')}</option><option value="reminder">${t('calendar.type.reminder')}</option><option value="other">${t('common.other')}</option></select></div>
                <div class="form-group"><label for="event-date">${t('common.date')}</label><input type="date" id="event-date" class="form-control" required></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label for="event-amount">${t('common.amount')}</label><input type="number" id="event-amount" class="form-control" step="0.01"></div>
                <div class="form-group"><label for="event-currency">${t('common.currency')}</label><select id="event-currency" class="form-control">${UI.currencyOptions()}</select></div>
                <div class="form-group"><label for="event-color">${t('calendar.color')}</label><input type="color" id="event-color" class="form-control" value="#5D5CDE"></div>
              </div>
              <div class="form-group"><label for="event-description">${t('common.description')}</label><textarea id="event-description" class="form-control"></textarea></div>
              <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="ui:close">${t('btn.cancel')}</button><button type="submit" class="btn btn-primary">${t('btn.save')}</button></div>
            </form>
          </div>
        </div>
      </div>
    `;
  }
};

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'cal:day': (el) => CalendarModule.showDayEvents(el.dataset.date),
    'cal:add': (el) => { UI.closeModal('day-modal'); CalendarModule.showAddModal(el.dataset.date); },
    'cal:save': () => CalendarModule.saveEvent(),
    'cal:complete': (el) => CalendarModule.completeEvent(el.dataset.id),
    'cal:prev': () => CalendarModule.prevMonth(),
    'cal:next': () => CalendarModule.nextMonth(),
    'cal:today': () => CalendarModule.goToday(),
  });
})();
