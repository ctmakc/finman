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

function renderFamilyPage() {
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="family-page">
      <header class="page-header">
        <h1><i class="fas fa-users"></i> Семейный доступ</h1>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="showCreateFamilyModal()">
            <i class="fas fa-plus"></i> Создать семью
          </button>
          <button class="btn btn-secondary" onclick="showJoinFamilyModal()">
            <i class="fas fa-sign-in-alt"></i> Присоединиться
          </button>
        </div>
      </header>

      <div class="family-content">
        <div class="families-list" id="families-list">
          <div class="loading"><i class="fas fa-spinner fa-spin"></i> Загрузка...</div>
        </div>
      </div>
    </div>
  `;

  loadFamilies();
}

async function loadFamilies() {
  const families = await fetchFamilies();
  const container = document.getElementById('families-list');

  if (families.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-users"></i>
        <h3>Нет семей</h3>
        <p>Создайте семью или присоединитесь по коду приглашения</p>
      </div>
    `;
    return;
  }

  container.innerHTML = families.map(family => `
    <div class="family-card" onclick="openFamilyDetails(${family.id})">
      <div class="family-header">
        <h3>${escapeHtml(family.name)}</h3>
        <span class="role-badge role-${family.my_role}">${getRoleName(family.my_role)}</span>
      </div>
      <div class="family-info">
        <span><i class="fas fa-user"></i> Владелец: ${escapeHtml(family.owner_username)}</span>
        <span><i class="fas fa-users"></i> ${family.member_count} участник(ов)</span>
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

  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="family-details-page">
      <header class="page-header">
        <button class="btn-back" onclick="renderFamilyPage()">
          <i class="fas fa-arrow-left"></i> Назад
        </button>
        <h1>${escapeHtml(family.name)}</h1>
        <span class="role-badge role-${family.myRole}">${getRoleName(family.myRole)}</span>
      </header>

      <div class="family-details-content">
        ${family.myRole === 'owner' || family.myRole === 'admin' ? `
          <div class="invite-section">
            <h3><i class="fas fa-link"></i> Код приглашения</h3>
            <div class="invite-code-box">
              <code id="invite-code">${family.invite_code}</code>
              <button class="btn-icon" onclick="copyInviteCode()" title="Копировать">
                <i class="fas fa-copy"></i>
              </button>
              ${family.myRole === 'owner' ? `
                <button class="btn-icon" onclick="regenerateCode(${family.id})" title="Обновить код">
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
                    ${member.full_name ? member.full_name[0].toUpperCase() : member.username[0].toUpperCase()}
                  </div>
                  <div class="member-details">
                    <strong>${escapeHtml(member.full_name || member.username)}</strong>
                    <span class="member-email">${escapeHtml(member.email)}</span>
                  </div>
                </div>
                <div class="member-actions">
                  <span class="role-badge role-${member.role}">${getRoleName(member.role)}</span>
                  ${family.myRole === 'owner' && member.role !== 'owner' ? `
                    <div class="dropdown">
                      <button class="btn-icon dropdown-toggle" onclick="toggleDropdown(this)">
                        <i class="fas fa-ellipsis-v"></i>
                      </button>
                      <div class="dropdown-menu">
                        ${member.role === 'member' ? `
                          <a onclick="promoteMember(${family.id}, ${member.user_id}, 'admin')">
                            <i class="fas fa-arrow-up"></i> Сделать админом
                          </a>
                        ` : `
                          <a onclick="promoteMember(${family.id}, ${member.user_id}, 'member')">
                            <i class="fas fa-arrow-down"></i> Снять админа
                          </a>
                        `}
                        <a onclick="kickMember(${family.id}, ${member.user_id})" class="danger">
                          <i class="fas fa-user-minus"></i> Удалить
                        </a>
                        <a onclick="showPermissionsModal(${member.user_id}, '${escapeHtml(member.username)}')">
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
            <button class="btn btn-danger" onclick="confirmLeaveFamily(${family.id})">
              <i class="fas fa-sign-out-alt"></i> Покинуть семью
            </button>
          ` : `
            <button class="btn btn-danger" onclick="confirmDeleteFamily(${family.id})">
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
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'create-family-modal';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Создать семью</h3>
        <button class="btn-close" onclick="closeModal('create-family-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Название семьи</label>
          <input type="text" id="family-name" placeholder="Например: Семья Ивановых" required>
        </div>
        <div class="form-group">
          <label>Описание (необязательно)</label>
          <textarea id="family-description" placeholder="Краткое описание"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('create-family-modal')">Отмена</button>
        <button class="btn btn-primary" onclick="submitCreateFamily()">Создать</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
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
    closeModal('create-family-modal');
    loadFamilies();
  }
}

function showJoinFamilyModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'join-family-modal';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Присоединиться к семье</h3>
        <button class="btn-close" onclick="closeModal('join-family-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Код приглашения</label>
          <input type="text" id="invite-code-input" placeholder="Введите код" maxlength="12" style="text-transform: uppercase;">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('join-family-modal')">Отмена</button>
        <button class="btn btn-primary" onclick="submitJoinFamily()">Присоединиться</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function submitJoinFamily() {
  const code = document.getElementById('invite-code-input').value.trim().toUpperCase();

  if (!code) {
    showNotification('Введите код приглашения', 'error');
    return;
  }

  const family = await joinFamily(code);
  if (family) {
    closeModal('join-family-modal');
    loadFamilies();
  }
}

function copyInviteCode() {
  const code = document.getElementById('invite-code').textContent;
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
  const accounts = appState.accounts || [];

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'permissions-modal';
  modal.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <h3>Права доступа для ${escapeHtml(username)}</h3>
        <button class="btn-close" onclick="closeModal('permissions-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="info-text">Выберите счета и права доступа:</p>
        <div class="permissions-list">
          ${accounts.length === 0 ? '<p>Нет счетов</p>' : accounts.map(account => `
            <div class="permission-item" data-account-id="${account.id}">
              <div class="permission-account">
                <strong>${escapeHtml(account.name)}</strong>
                <span class="account-balance">${formatCurrency(account.balance, account.currency)}</span>
              </div>
              <div class="permission-checkboxes">
                <label>
                  <input type="checkbox" class="perm-view" checked> Просмотр
                </label>
                <label>
                  <input type="checkbox" class="perm-add"> Добавление
                </label>
                <label>
                  <input type="checkbox" class="perm-edit"> Редактирование
                </label>
                <label>
                  <input type="checkbox" class="perm-delete"> Удаление
                </label>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('permissions-modal')">Отмена</button>
        <button class="btn btn-primary" onclick="savePermissions(${userId})">Сохранить</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
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

  closeModal('permissions-modal');
  showNotification('Права сохранены', 'success');
}

function toggleDropdown(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains('show');

  // Закрываем все открытые dropdown
  document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));

  if (!isOpen) {
    menu.classList.add('show');
  }
}

// Закрытие dropdown при клике вне
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
  }
});

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.remove();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatCurrency(amount, currency = 'UAH') {
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: currency
  }).format(amount);
}
