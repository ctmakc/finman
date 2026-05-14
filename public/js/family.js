// Family Management Module

// ==================== API ====================

async function fetchFamilies() {
  try {
    const response = await fetch('/api/family', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Failed to load families');

    const families = await response.json();
    appState.families = families;
    return families;
  } catch (error) {
    console.error('Error fetching families:', error);
    showNotification('Failed to load families', 'error');
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
      throw new Error(data.message || 'Failed to create family');
    }

    showNotification('Family created successfully', 'success');
    return data.family;
  } catch (error) {
    console.error('Error on create family:', error);
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
      throw new Error(data.message || 'Error joining');
    }

    showNotification('You joined the family!', 'success');
    return data.family;
  } catch (error) {
    console.error('Error joining:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function fetchFamilyDetails(familyId) {
  try {
    const response = await fetch(`/api/family/${familyId}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Failed to load data family');

    return await response.json();
  } catch (error) {
    console.error('Error:', error);
    showNotification('Failed to load family', 'error');
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
      throw new Error(data.message || 'Error');
    }

    showNotification('You left the family', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Failed to delete');
    }

    showNotification('Family deleted', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Error');
    }

    showNotification('Member removed', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Error');
    }

    showNotification('Role updated', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Error');
    }

    showNotification('Invite code updated', 'success');
    return data.inviteCode;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Error');
    }

    showNotification('Permissions granted', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
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
      throw new Error(data.message || 'Error');
    }

    showNotification('Permissions revoked', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
    showNotification(error.message, 'error');
    return false;
  }
}

async function fetchAccountPermissions(accountId) {
  try {
    const response = await fetch(`/api/family/accounts/${accountId}/permissions`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('Error');

    return await response.json();
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}

// ==================== UI ====================

function renderFamilyPage() {
  const mc = document.getElementById('main-content');
  if (!mc) return;

  mc.innerHTML = `
    <div class="family-page">
      <header class="page-header">
        <h1><i class="fas fa-users"></i> Family Access</h1>
        <div class="header-actions">
          <button class="btn btn-primary" onclick="showCreateFamilyModal()">
            <i class="fas fa-plus"></i> Create family
          </button>
          <button class="btn btn-secondary" onclick="showJoinFamilyModal()">
            <i class="fas fa-sign-in-alt"></i> Join
          </button>
        </div>
      </header>

      <div class="family-content">
        <div class="families-list" id="families-list">
          <div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
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
        <h3>No families</h3>
        <p>Create a family or join one with an invite code</p>
      </div>
    `;
    return;
  }

  container.innerHTML = families.map(family => `
    <div class="family-card" onclick="openFamilyDetails(${family.id})">
      <div class="family-header">
        <h3>${esc(family.name)}</h3>
        <span class="role-badge role-${family.my_role}">${getRoleName(family.my_role)}</span>
      </div>
      <div class="family-info">
        <span><i class="fas fa-user"></i> Owner: ${esc(family.owner_username)}</span>
        <span><i class="fas fa-users"></i> ${family.member_count} member(s)</span>
      </div>
    </div>
  `).join('');
}

function getRoleName(role) {
  const roles = {
    'owner': 'Owner',
    'admin': 'Admin',
    'member': 'Member'
  };
  return roles[role] || role;
}

async function openFamilyDetails(familyId) {
  const family = await fetchFamilyDetails(familyId);
  if (!family) return;

  const mc = document.getElementById('main-content');
  if (!mc) return;

  mc.innerHTML = `
    <div class="family-details-page">
      <header class="page-header">
        <button class="btn-back" onclick="renderFamilyPage()">
          <i class="fas fa-arrow-left"></i> Back
        </button>
        <h1>${esc(family.name)}</h1>
        <span class="role-badge role-${family.myRole}">${getRoleName(family.myRole)}</span>
      </header>

      <div class="family-details-content">
        ${family.myRole === 'owner' || family.myRole === 'admin' ? `
          <div class="invite-section">
            <h3><i class="fas fa-link"></i> Invite code</h3>
            <div class="invite-code-box">
              <code id="invite-code">${family.invite_code}</code>
              <button class="btn-icon" onclick="copyInviteCode()" title="Copy">
                <i class="fas fa-copy"></i>
              </button>
              ${family.myRole === 'owner' ? `
                <button class="btn-icon" onclick="regenerateCode(${family.id})" title="Refresh code">
                  <i class="fas fa-sync"></i>
                </button>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <div class="members-section">
          <h3><i class="fas fa-users"></i> Members (${family.members.length})</h3>
          <div class="members-list">
            ${family.members.map(member => `
              <div class="member-card">
                <div class="member-info">
                  <div class="member-avatar">
                    ${member.full_name ? member.full_name[0].toUpperCase() : member.username[0].toUpperCase()}
                  </div>
                  <div class="member-details">
                    <strong>${esc(member.full_name || member.username)}</strong>
                    <span class="member-email">${esc(member.email)}</span>
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
                            <i class="fas fa-arrow-up"></i> Make admin
                          </a>
                        ` : `
                          <a onclick="promoteMember(${family.id}, ${member.user_id}, 'member')">
                            <i class="fas fa-arrow-down"></i> Remove admin
                          </a>
                        `}
                        <a onclick="kickMember(${family.id}, ${member.user_id})" class="danger">
                          <i class="fas fa-user-minus"></i> Delete
                        </a>
                        <a onclick="showPermissionsModal(${member.user_id}, '${esc(member.username)}')">
                          <i class="fas fa-key"></i> Permissions
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
              <i class="fas fa-sign-out-alt"></i> Leave family
            </button>
          ` : `
            <button class="btn btn-danger" onclick="confirmDeleteFamily(${family.id})">
              <i class="fas fa-trash"></i> Delete family
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
        <h3>Create family</h3>
        <button class="btn-close" onclick="closeModal('create-family-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Name family</label>
          <input type="text" id="family-name" placeholder="E.g.: The Smith Family" required>
        </div>
        <div class="form-group">
          <label>Description (optional)</label>
          <textarea id="family-description" placeholder="Brief description"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('create-family-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="submitCreateFamily()">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function submitCreateFamily() {
  const name = document.getElementById('family-name').value.trim();
  const description = document.getElementById('family-description').value.trim();

  if (!name) {
    showNotification('Enter a family name', 'error');
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
        <h3>Join a family</h3>
        <button class="btn-close" onclick="closeModal('join-family-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Invite code</label>
          <input type="text" id="invite-code-input" placeholder="Enter code" maxlength="12" style="text-transform: uppercase;">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('join-family-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="submitJoinFamily()">Join</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function submitJoinFamily() {
  const code = document.getElementById('invite-code-input').value.trim().toUpperCase();

  if (!code) {
    showNotification('Enter the invite code', 'error');
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
    showNotification('Code copied to clipboard', 'success');
  });
}

function regenerateCode(familyId) {
  showConfirm('The old invite code will stop working. Continue?', async () => {
    const newCode = await regenerateInviteCode(familyId);
    if (newCode) document.getElementById('invite-code').textContent = newCode;
  }, { danger: false, confirmLabel: 'Regenerate', title: 'Regenerate invite code' });
}

async function promoteMember(familyId, userId, role) {
  if (await changeMemberRole(familyId, userId, role)) {
    openFamilyDetails(familyId);
  }
}

function kickMember(familyId, userId) {
  showConfirm('Remove this member from the family?', async () => {
    if (await removeMember(familyId, userId)) openFamilyDetails(familyId);
  }, { title: 'Remove member' });
}

function confirmLeaveFamily(familyId) {
  showConfirm('Are you sure you want to leave this family?', async () => {
    if (await leaveFamily(familyId)) renderFamilyPage();
  }, { title: 'Leave family' });
}

function confirmDeleteFamily(familyId) {
  showConfirm('Delete family? All members will lose access.', async () => {
    if (await deleteFamily(familyId)) renderFamilyPage();
  }, { title: 'Delete family' });
}

function showPermissionsModal(userId, username) {
  const accounts = appState.accounts || [];

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'permissions-modal';
  modal.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <h3>Permissions for ${esc(username)}</h3>
        <button class="btn-close" onclick="closeModal('permissions-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="info-text">Select accounts and permissions:</p>
        <div class="permissions-list">
          ${accounts.length === 0 ? '<p>No accounts</p>' : accounts.map(account => `
            <div class="permission-item" data-account-id="${account.id}">
              <div class="permission-account">
                <strong>${esc(account.name)}</strong>
                <span class="account-balance">${formatCurrency(account.balance, account.currency)}</span>
              </div>
              <div class="permission-checkboxes">
                <label>
                  <input type="checkbox" class="perm-view" checked> View
                </label>
                <label>
                  <input type="checkbox" class="perm-add"> Adding
                </label>
                <label>
                  <input type="checkbox" class="perm-edit"> Edit
                </label>
                <label>
                  <input type="checkbox" class="perm-delete"> Delete
                </label>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('permissions-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="savePermissions(${userId})">Save</button>
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
  showNotification('Permissions saved', 'success');
}

function toggleDropdown(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains('show');

  // Закрываем all открытые dropdown
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

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// formatCurrency defined in app.js
