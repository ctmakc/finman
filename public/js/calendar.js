// Calendar Module
const CalendarModule = {
  events: [],
  currentDate: new Date(),
  view: 'month',

  async init() {
    await this.loadEvents();
  },

  async loadEvents() {
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const start = new Date(year, month, 1).toISOString().split('T')[0];
    const end = new Date(year, month + 1, 0).toISOString().split('T')[0];

    try {
      const response = await fetch(`/api/calendar/events?start=${start}&end=${end}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.events = await response.json();
      this.render();
    } catch (error) {
      console.error('Error loading events:', error);
    }
  },

  render() {
    const container = document.getElementById('calendar-grid');
    if (!container) return;

    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date().toISOString().split('T')[0];

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    document.getElementById('calendar-title').textContent = `${monthNames[month]} ${year}`;

    let html = '<div class="calendar-header-row"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>';
    html += '<div class="calendar-days">';

    const startDay = firstDay === 0 ? 6 : firstDay - 1;
    for (let i = 0; i < startDay; i++) {
      html += '<div class="calendar-day empty"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayEvents = this.events.filter(e => e.event_date === dateStr);
      const isToday = dateStr === today;

      html += `<div class="calendar-day ${isToday ? 'today' : ''} ${dayEvents.length ? 'has-events' : ''}" onclick="CalendarModule.showDayEvents('${dateStr}')">
        <span class="day-number">${day}</span>
        ${dayEvents.slice(0, 3).map(e => `<div class="event-dot" style="background:${e.color || '#5D5CDE'}" title="${e.title}"></div>`).join('')}
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
      const response = await fetch('/api/calendar/upcoming', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const upcoming = await response.json();

      if (upcoming.length === 0) {
        container.innerHTML = '<p class="text-secondary">No upcoming events</p>';
        return;
      }

      const typeIcons = { payment: '💳', income: '💰', reminder: '🔔', goal: '🎯', debt: '📋', subscription: '📦', recurring: '🔄' };

      container.innerHTML = upcoming.map(e => `
        <div class="upcoming-item" style="border-left: 3px solid ${e.color || '#5D5CDE'}">
          <span class="event-icon">${typeIcons[e.event_type] || '📅'}</span>
          <div class="event-info"><strong>${e.title}</strong><small>${e.event_date}</small></div>
          ${e.amount ? `<span class="event-amount">${e.amount.toLocaleString()} $</span>` : ''}
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
    const typeIcons = { payment: '💳', income: '💰', reminder: '🔔', goal: '🎯', debt: '📋', subscription: '📦', recurring: '🔄' };

    document.getElementById('day-events-date').textContent = dateStr;
    document.getElementById('day-events-list').innerHTML = dayEvents.length === 0 
      ? '<p>No events</p>'
      : dayEvents.map(e => `
        <div class="day-event-item">
          <span>${typeIcons[e.event_type] || '📅'}</span>
          <div><strong>${e.title}</strong>${e.amount ? ` - ${e.amount.toLocaleString()} $` : ''}<br><small>${e.description || e.event_type}</small></div>
          ${e.source ? '' : `<button class="btn btn-sm btn-icon" onclick="CalendarModule.completeEvent(${e.id})">✓</button>`}
        </div>
      `).join('');

    document.getElementById('day-modal').classList.add('active');
  },

  showAddModal(dateStr) {
    document.getElementById('event-form').reset();
    document.getElementById('event-date').value = dateStr || new Date().toISOString().split('T')[0];
    document.getElementById('event-modal').classList.add('active');
  },

  async saveEvent() {
    const data = {
      title: document.getElementById('event-title').value,
      event_type: document.getElementById('event-type').value,
      event_date: document.getElementById('event-date').value,
      amount: document.getElementById('event-amount').value ? parseFloat(document.getElementById('event-amount').value) : null,
      description: document.getElementById('event-description').value,
      color: document.getElementById('event-color').value
    };

    try {
      await fetch('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify(data)
      });
      document.getElementById('event-modal').classList.remove('active');
      await this.loadEvents();
    } catch (error) {
      alert('Error');
    }
  },

  async completeEvent(id) {
    try {
      await fetch(`/api/calendar/events/${id}/complete`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      await this.loadEvents();
      document.getElementById('day-modal').classList.remove('active');
    } catch (error) {
      alert('Error');
    }
  },

  getPage() {
    return `
      <div class="calendar-page">
        <div class="page-header"><h1>📅 Finance Calendar</h1>
          <button class="btn btn-primary" onclick="CalendarModule.showAddModal()">+ Event</button>
        </div>
        <div class="calendar-container card">
          <div class="calendar-nav">
            <button class="btn btn-icon" onclick="CalendarModule.prevMonth()">◀</button>
            <h2 id="calendar-title"></h2>
            <button class="btn btn-icon" onclick="CalendarModule.nextMonth()">▶</button>
            <button class="btn btn-sm" onclick="CalendarModule.goToday()">Today</button>
          </div>
          <div id="calendar-grid"></div>
        </div>
        <div class="card"><h3>🔔 Upcoming Events</h3><div id="upcoming-events"></div></div>
      </div>
      <div class="modal" id="day-modal">
        <div class="modal-content">
          <div class="modal-header"><h2>Events <span id="day-events-date"></span></h2><button class="modal-close" onclick="document.getElementById('day-modal').classList.remove('active')">&times;</button></div>
          <div id="day-events-list"></div>
        </div>
      </div>
      <div class="modal" id="event-modal">
        <div class="modal-content">
          <div class="modal-header"><h2>New Event</h2><button class="modal-close" onclick="document.getElementById('event-modal').classList.remove('active')">&times;</button></div>
          <form id="event-form" onsubmit="event.preventDefault(); CalendarModule.saveEvent()">
            <div class="form-group"><label>Name</label><input type="text" id="event-title" class="form-control" required></div>
            <div class="form-row">
              <div class="form-group"><label>Type</label><select id="event-type" class="form-control"><option value="payment">Payment</option><option value="income">Income</option><option value="reminder">Reminder</option><option value="other">Other</option></select></div>
              <div class="form-group"><label>Date</label><input type="date" id="event-date" class="form-control" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Amount</label><input type="number" id="event-amount" class="form-control" step="0.01"></div>
              <div class="form-group"><label>Color</label><input type="color" id="event-color" class="form-control" value="#5D5CDE"></div>
            </div>
            <div class="form-group"><label>Description</label><textarea id="event-description" class="form-control"></textarea></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('event-modal').classList.remove('active')">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
