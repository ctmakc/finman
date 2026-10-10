// Модуль управления семьей и правами доступа

// ==================== API ====================

async function fetchFamilies() {
  try {
    const response = await fetch('/api/family', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Ошибка загрузки семей');

    const families = await response.json();
    appState.families = families;
    return families;
  } catch (error) {
    console.error('Ошибка при получении семей:', error);
    showNotification('Ошибка загрузки семей', 'error');
    return [];
  }
}

async function createFamily(name, description) {
  try {
    const response = await fetch('/api/family', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ name, description })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка создания семьи');
    }

    showNotification('Семья создана успешно', 'success');
    return data.family;
  } catch (error) {
    console.error('Ошибка при создании семьи:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function joinFamily(inviteCode) {
  try {
    const response = await fetch('/api/family/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ inviteCode })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка присоединения');
    }

    showNotification('Вы присоединились к семье!', 'success');
    return data.family;
  } catch (error) {
    console.error('Ошибка при присоединении:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function fetchFamilyDetails(familyId) {
  try {
    const response = await fetch(`/api/family/${familyId}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Ошибка загрузки данных семьи');

    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification('Ошибка загрузки семьи', 'error');
    return null;
  }
}

async function leaveFamily(familyId) {
  try {
    const response = await fetch(`/api/family/${familyId}/leave`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Вы покинули семью', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function deleteFamily(familyId) {
  try {
    const response = await fetch(`/api/family/${familyId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка удаления');
    }

    showNotification('Семья удалена', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function removeMember(familyId, userId) {
  try {
    const response = await fetch(`/api/family/${familyId}/members/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Участник удален', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function changeMemberRole(familyId, userId, role) {
  try {
    const response = await fetch(`/api/family/${familyId}/members/${userId}/role`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ role })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Роль изменена', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function regenerateInviteCode(familyId) {
  try {
    const response = await fetch(`/api/family/${familyId}/regenerate-code`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Код обновлен', 'success');
    return data.inviteCode;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function grantAccountPermissions(accountId, userId, permissions) {
  try {
    const response = await fetch(`/api/family/accounts/${accountId}/permissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ userId, ...permissions })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Права выданы', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function revokeAccountPermissions(accountId, userId) {
  try {
    const response = await fetch(`/api/family/accounts/${accountId}/permissions/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Ошибка');
    }

    showNotification('Права отозваны', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function fetchAccountPermissions(accountId) {
  try {
    const response = await fetch(`/api/family/accounts/${accountId}/permissions`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Ошибка');

    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    return [];
  }
}

// ==================== UI ====================
// The page renders into #main-content like every other module (app.js
// navigateTo convention), so header, nav and theme toggle stay in place.
// All handlers are delegated through UI.actions (no inline onclick).

function familyContainer() {
  return document.getElementById('main-content');
}

function renderFamilyPage() {
  const container = familyContainer();
  if (!container) return;

  container.innerHTML = `
    <div class="family-page">
      <header class="page-header">
        <h1><i class="fas fa-users"></i> Семейный доступ</h1>
        <div class="header-actions">
          <button type="button" class="btn btn-primary" data-action="family:create">
            <i class="fas fa-plus"></i> Создать семью
          </button>
          <button type="button" class="btn btn-secondary" data-action="family:join">
            <i class="fas fa-sign-in-alt"></i> Присоединиться
          </button>
        </div>
      </header>

      <div class="family-content">
        <div class="families-list" id="families-list">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    </div>
  `;

  loadFamilies();
}

async function loadFamilies() {
  const families = await fetchFamilies();
  const container = document.getElementById('families-list');
  if (!container) return;

  if (families.length === 0) {
    container.innerHTML = UI.emptyState({
      icon: 'fa-users',
      title: 'Нет семей',
      text: 'Создайте семью или присоединитесь по коду приглашения — общие счета станут видны всем участникам.',
      action: { label: 'Создать семью', action: 'family:create', icon: 'fa-plus' }
    });
    return;
  }

  container.innerHTML = families.map(family => `
    <div class="family-card" data-action="family:open" data-id="${Number(family.id)}" role="button" tabindex="0">
      <div class="family-header">
        <h3>${UI.esc(family.name)}</h3>
        <span class="role-badge role-${UI.esc(family.my_role)}">${UI.esc(getRoleName(family.my_role))}</span>
      </div>
      <div class="family-info">
        <span><i class="fas fa-user"></i> Владелец: ${UI.esc(family.owner_username)}</span>
        <span><i class="fas fa-users"></i> ${Number(family.member_count) || 0} участник(ов)</span>
      </div>
    </div>
  `).join('');
}

function getRoleName(role) {
  const roles = {
    'owner': 'Владелец',
    'admin': 'Админ',
    'member': 'Участник'
  };
  return roles[role] || role;
}

async function openFamilyDetails(familyId) {
  const family = await fetchFamilyDetails(familyId);
  if (!family) return;

  const container = familyContainer();
  if (!container) return;
  const esc = UI.esc;
  const canManage = family.myRole === 'owner' || family.myRole === 'admin';

  container.innerHTML = `
    <div class="family-details-page">
      <header class="page-header">
        <button type="button" class="btn-back" data-action="family:back">
          <i class="fas fa-arrow-left"></i> Назад
        </button>
        <h1>${esc(family.name)}</h1>
        <span class="role-badge role-${esc(family.myRole)}">${esc(getRoleName(family.myRole))}</span>
      </header>

      <div class="family-details-content">
        ${canManage ? `
          <div class="invite-section">
            <h3><i class="fas fa-link"></i> Код приглашения</h3>
            <div class="invite-code-box">
              <code id="invite-code">${esc(family.invite_code)}</code>
              <button type="button" class="btn-icon" data-action="family:copy-code" title="Копировать" aria-label="Копировать код">
                <i class="fas fa-copy"></i>
              </button>
              ${family.myRole === 'owner' ? `
                <button type="button" class="btn-icon" data-action="family:regenerate" data-id="${Number(family.id)}" title="Обновить код" aria-label="Обновить код">
                  <i class="fas fa-sync"></i>
                </button>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <div class="members-section">
          <h3><i class="fas fa-users"></i> Участники (${family.members.length})</h3>
          <div class="members-list">
            ${family.members.map(member => `
              <div class="member-card">
                <div class="member-info">
                  <div class="member-avatar">
                    ${esc((member.full_name || member.username || '?')[0].toUpperCase())}
                  </div>
                  <div class="member-details">
                    <strong>${esc(member.full_name || member.username)}</strong>
                    <span class="member-email">${esc(member.email)}</span>
                  </div>
                </div>
                <div class="member-actions">
                  <span class="role-badge role-${esc(member.role)}">${esc(getRoleName(member.role))}</span>
                  ${family.myRole === 'owner' && member.role !== 'owner' ? `
                    <div class="dropdown">
                      <button type="button" class="btn-icon dropdown-toggle" data-action="family:menu" aria-haspopup="true" aria-expanded="false" aria-label="Действия с участником">
                        <i class="fas fa-ellipsis-v"></i>
                      </button>
                      <div class="dropdown-menu">
                        ${member.role === 'member' ? `
                          <a href="#" data-action="family:role" data-id="${Number(family.id)}" data-user="${Number(member.user_id)}" data-role="admin">
                            <i class="fas fa-arrow-up"></i> Сделать админом
                          </a>
                        ` : `
                          <a href="#" data-action="family:role" data-id="${Number(family.id)}" data-user="${Number(member.user_id)}" data-role="member">
                            <i class="fas fa-arrow-down"></i> Снять админа
                          </a>
                        `}
                        <a href="#" data-action="family:kick" data-id="${Number(family.id)}" data-user="${Number(member.user_id)}" class="danger">
                          <i class="fas fa-user-minus"></i> Удалить
                        </a>
                        <a href="#" data-action="family:permissions" data-user="${Number(member.user_id)}" data-username="${esc(member.username)}">
                          <i class="fas fa-key"></i> Права доступа
                        </a>
                      </div>
                    </div>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="family-actions">
          ${family.myRole !== 'owner' ? `
            <button type="button" class="btn btn-danger" data-action="family:leave" data-id="${Number(family.id)}">
              <i class="fas fa-sign-out-alt"></i> Покинуть семью
            </button>
          ` : `
            <button type="button" class="btn btn-danger" data-action="family:delete" data-id="${Number(family.id)}">
              <i class="fas fa-trash"></i> Удалить семью
            </button>
          `}
        </div>
      </div>
    </div>
  `;

  appState.currentFamily = family;
}

function showCreateFamilyModal() {
  UI.modal({
    id: 'create-family-modal',
    title: 'Создать семью',
    body: `
      <form id="create-family-form" data-submit="family:create-submit">
        <div class="form-group">
          <label for="family-name">Название семьи</label>
          <input type="text" id="family-name" class="form-control" placeholder="Например: Семья Ивановых" required>
        </div>
        <div class="form-group">
          <label for="family-description">Описание (необязательно)</label>
          <textarea id="family-description" class="form-control" placeholder="Краткое описание"></textarea>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Создать</button>
        </div>
      </form>`
  });
}

async function submitCreateFamily() {
  const name = document.getElementById('family-name').value.trim();
  const description = document.getElementById('family-description').value.trim();

  if (!name) {
    showNotification('Введите название семьи', 'error');
    return;
  }

  const family = await createFamily(name, description);
  if (family) {
    UI.closeModal('create-family-modal');
    loadFamilies();
  }
}

function showJoinFamilyModal() {
  UI.modal({
    id: 'join-family-modal',
    title: 'Присоединиться к семье',
    body: `
      <form id="join-family-form" data-submit="family:join-submit">
        <div class="form-group">
          <label for="invite-code-input">Код приглашения</label>
          <input type="text" id="invite-code-input" class="form-control" placeholder="Введите код" maxlength="12" autocapitalize="characters">
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Присоединиться</button>
        </div>
      </form>`
  });
}

async function submitJoinFamily() {
  const code = document.getElementById('invite-code-input').value.trim().toUpperCase();

  if (!code) {
    showNotification('Введите код приглашения', 'error');
    return;
  }

  const family = await joinFamily(code);
  if (family) {
    UI.closeModal('join-family-modal');
    loadFamilies();
  }
}

function copyInviteCode() {
  const el = document.getElementById('invite-code');
  if (!el) return;
  const code = el.textContent;
  if (!navigator.clipboard) { showNotification('Код: ' + code, 'info'); return; }
  navigator.clipboard.writeText(code).then(() => {
    showNotification('Код скопирован', 'success');
  });
}

async function regenerateCode(familyId) {
  if (!confirm('Старый код перестанет работать. Продолжить?')) return;

  const newCode = await regenerateInviteCode(familyId);
  if (newCode) {
    document.getElementById('invite-code').textContent = newCode;
  }
}

async function promoteMember(familyId, userId, role) {
  if (await changeMemberRole(familyId, userId, role)) {
    openFamilyDetails(familyId);
  }
}

async function kickMember(familyId, userId) {
  if (!confirm('Удалить участника из семьи?')) return;

  if (await removeMember(familyId, userId)) {
    openFamilyDetails(familyId);
  }
}

async function confirmLeaveFamily(familyId) {
  if (!confirm('Вы уверены, что хотите покинуть семью?')) return;

  if (await leaveFamily(familyId)) {
    renderFamilyPage();
  }
}

async function confirmDeleteFamily(familyId) {
  if (!confirm('Удалить семью? Все участники потеряют доступ.')) return;

  if (await deleteFamily(familyId)) {
    renderFamilyPage();
  }
}

function showPermissionsModal(userId, username) {
  const accounts = UI.accountsArray();
  const esc = UI.esc;

  UI.modal({
    id: 'permissions-modal',
    size: 'lg',
    title: `Права доступа для ${username}`,
    body: `
      <p class="info-text">Выберите счета и права доступа:</p>
      <div class="permissions-list">
        ${accounts.length === 0 ? '<p>Нет счетов</p>' : accounts.map(account => `
          <div class="permission-item" data-account-id="${Number(account.id)}">
            <div class="permission-account">
              <strong>${esc(account.name)}</strong>
              <span class="account-balance">${esc(UI.money(account.balance, account.currency))}</span>
            </div>
            <div class="permission-checkboxes">
              <label><input type="checkbox" class="perm-view" checked> Просмотр</label>
              <label><input type="checkbox" class="perm-add"> Добавление</label>
              <label><input type="checkbox" class="perm-edit"> Редактирование</label>
              <label><input type="checkbox" class="perm-delete"> Удаление</label>
            </div>
          </div>
        `).join('')}
      </div>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button>
      <button type="button" class="btn btn-primary" data-action="family:save-permissions" data-user="${Number(userId)}">Сохранить</button>`
  });
}

async function savePermissions(userId) {
  const items = document.querySelectorAll('.permission-item');

  for (const item of items) {
    const accountId = item.dataset.accountId;
    const canView = item.querySelector('.perm-view').checked;
    const canAddTransactions = item.querySelector('.perm-add').checked;
    const canEdit = item.querySelector('.perm-edit').checked;
    const canDelete = item.querySelector('.perm-delete').checked;

    if (canView || canAddTransactions || canEdit || canDelete) {
      await grantAccountPermissions(accountId, userId, {
        canView,
        canAddTransactions,
        canEdit,
        canDelete
      });
    }
  }

  UI.closeModal('permissions-modal');
  showNotification('Права сохранены', 'success');
}

function toggleDropdown(btn) {
  const menu = btn.nextElementSibling;
  if (!menu) return;
  const isOpen = menu.classList.contains('show');

  // Закрываем все открытые dropdown
  closeFamilyDropdowns();

  if (!isOpen) {
    menu.classList.add('show');
    btn.setAttribute('aria-expanded', 'true');
  }
}

function closeFamilyDropdowns() {
  document.querySelectorAll('.dropdown-menu.show').forEach(m => {
    m.classList.remove('show');
    const toggle = m.previousElementSibling;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

// Закрытие dropdown при клике вне
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) closeFamilyDropdowns();
});

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'family:create': () => showCreateFamilyModal(),
    'family:create-submit': () => submitCreateFamily(),
    'family:join': () => showJoinFamilyModal(),
    'family:join-submit': () => submitJoinFamily(),
    'family:open': (el) => openFamilyDetails(Number(el.dataset.id)),
    'family:back': () => renderFamilyPage(),
    'family:copy-code': () => copyInviteCode(),
    'family:regenerate': (el) => regenerateCode(Number(el.dataset.id)),
    'family:menu': (el, e) => { e.stopPropagation(); toggleDropdown(el); },
    'family:role': (el) => { closeFamilyDropdowns(); promoteMember(Number(el.dataset.id), Number(el.dataset.user), el.dataset.role); },
    'family:kick': (el) => { closeFamilyDropdowns(); kickMember(Number(el.dataset.id), Number(el.dataset.user)); },
    'family:permissions': (el) => { closeFamilyDropdowns(); showPermissionsModal(Number(el.dataset.user), el.dataset.username); },
    'family:save-permissions': (el) => savePermissions(Number(el.dataset.user)),
    'family:leave': (el) => confirmLeaveFamily(Number(el.dataset.id)),
    'family:delete': (el) => confirmDeleteFamily(Number(el.dataset.id)),
  });
})();
