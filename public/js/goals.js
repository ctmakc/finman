// ==================== GOALS ====================
async function renderGoalsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const goals = await fetchWithAuth('/api/goals').then(r => r.json());
    const stats = await fetchWithAuth('/api/goals/stats').then(r => r.json());
    mainContent.innerHTML = `<div class="goals-page"><div class="page-header"><h1><i class="fas fa-piggy-bank"></i> Savings Goals</h1><button class="btn btn-primary" onclick="showAddGoalModal()"><i class="fas fa-plus"></i> New goal</button></div><div class="stats-grid">${renderGoalStats(stats)}</div><div class="card-grid" id="goals-list">${goals.length === 0 ? '<div class="empty-state"><i class="fas fa-piggy-bank"></i><h3>No goals</h3></div>' : goals.map(g => renderGoalCard(g)).join('')}</div></div>`;
  } catch (e) { mainContent.innerHTML = '<div class="alert alert-error">Failed to load</div>'; }
}
function renderGoalStats(stats) { return `<div class="stat-card"><div class="stat-icon"><i class="fas fa-bullseye"></i></div><div class="stat-data"><div class="stat-value">${stats.activeGoals}</div><div class="stat-label">Active</div></div></div><div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-coins"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(stats.totalSaved)}</div><div class="stat-label">Saved</div></div></div><div class="stat-card"><div class="stat-icon"><i class="fas fa-chart-pie"></i></div><div class="stat-data"><div class="stat-value">${stats.overallProgress}%</div><div class="stat-label">Progress</div></div></div>`; }
function renderGoalCard(g) {
  const p = g.progress || 0;
  const dueDate = g.target_date ? `<small class="text-muted" style="font-size:12px">Target: ${g.target_date}</small>` : '';
  return `<div class="card">
    <div class="card-header">
      <h3 class="card-title"><i class="fas fa-piggy-bank"></i> ${esc(g.name)}</h3>
      <div class="card-actions">
        <button class="btn btn-sm btn-outline" onclick="showContributeModal(${g.id})" title="Add funds"><i class="fas fa-plus"></i></button>
        ${g.current_amount > 0 ? `<button class="btn btn-sm btn-outline" onclick="showWithdrawModal(${g.id})" title="Withdraw"><i class="fas fa-minus"></i></button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteGoal(${g.id})"><i class="fas fa-trash"></i></button>
      </div>
    </div>
    <div class="budget-progress">
      <div class="progress-bar"><div class="progress-fill progress-ok" style="width:${Math.min(p, 100)}%"></div></div>
      <div class="progress-labels"><span>${formatCurrency(g.current_amount)} / ${formatCurrency(g.target_amount)}</span><span>${Math.round(p)}%</span></div>
    </div>
    ${g.remaining > 0 ? `<p>Remaining: ${formatCurrency(g.remaining)}</p>${dueDate}` : '<p class="text-success">Goal achieved! 🎉</p>'}
  </div>`;
}
async function showAddGoalModal() { const m = document.createElement('div'); m.className = 'modal-backdrop'; m.innerHTML = `<div class="modal"><div class="modal-header"><h2 class="modal-title">New goal</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="goal-form"><div class="form-group"><label class="form-label">Name</label><input type="text" name="name" class="form-control" required></div><div class="form-row"><div class="form-group"><label class="form-label">Amount</label><input type="number" name="target_amount" class="form-control" required min="1"></div><div class="form-group"><label class="form-label">Currency</label><select name="currency" class="form-control"><option value="UAH">UAH</option><option value="USD">USD</option><option value="EUR">EUR</option></select></div></div><div class="form-group"><label class="form-label">Date</label><input type="date" name="target_date" class="form-control"></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Cancel</button><button class="btn btn-primary" onclick="saveGoal()">Create</button></div></div>`; document.body.appendChild(m); }
async function saveGoal() { const f = document.getElementById('goal-form'); const d = Object.fromEntries(new FormData(f)); try { const r = await fetchWithAuth('/api/goals', { method: 'POST', body: JSON.stringify(d) }); if (!r.ok) throw new Error('Error'); document.querySelector('.modal-backdrop').remove(); showNotification('Goal created', 'success'); renderGoalsPage(); } catch (e) { showNotification(e.message, 'error'); } }
async function showContributeModal(id) { const m = document.createElement('div'); m.className = 'modal-backdrop'; m.innerHTML = `<div class="modal"><div class="modal-header"><h2>Fund</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="contribute-form"><input type="hidden" name="goalId" value="${id}"><div class="form-group"><label class="form-label">Amount</label><input type="number" name="amount" class="form-control" required min="0.01" step="0.01"></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Cancel</button><button class="btn btn-primary" onclick="contributeToGoal()">Fund</button></div></div>`; document.body.appendChild(m); }
async function contributeToGoal() { const f = document.getElementById('contribute-form'); const d = Object.fromEntries(new FormData(f)); try { const r = await fetchWithAuth('/api/goals/' + d.goalId + '/contribute', { method: 'POST', body: JSON.stringify({ amount: parseFloat(d.amount) }) }); if (!r.ok) throw new Error('Error'); document.querySelector('.modal-backdrop').remove(); showNotification('Contributed', 'success'); renderGoalsPage(); } catch (e) { showNotification(e.message, 'error'); } }
async function showWithdrawModal(id) {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `<div class="modal"><div class="modal-header"><h2>Withdraw from goal</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="withdraw-form"><input type="hidden" name="goalId" value="${id}"><div class="form-group"><label class="form-label">Amount</label><input type="number" name="amount" class="form-control" required min="0.01" step="0.01"></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Cancel</button><button class="btn btn-warning" onclick="withdrawFromGoal()">Withdraw</button></div></div>`;
  document.body.appendChild(m);
}
async function withdrawFromGoal() {
  const f = document.getElementById('withdraw-form');
  const d = Object.fromEntries(new FormData(f));
  try {
    const r = await fetchWithAuth('/api/goals/' + d.goalId + '/withdraw', { method: 'POST', body: JSON.stringify({ amount: parseFloat(d.amount) }) });
    if (!r.ok) throw new Error('Error');
    document.querySelector('.modal-backdrop').remove();
    showNotification('Withdrawn from goal', 'success');
    renderGoalsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}
async function deleteGoal(id) { showConfirm('Delete this goal?', async () => { try { await fetchWithAuth('/api/goals/' + id, { method: 'DELETE' }); showNotification('Deleted', 'success'); renderGoalsPage(); } catch (e) { showNotification('Error', 'error'); } }); }
window.showAddGoalModal = showAddGoalModal; window.showContributeModal = showContributeModal; window.saveGoal = saveGoal; window.contributeToGoal = contributeToGoal; window.showWithdrawModal = showWithdrawModal; window.withdrawFromGoal = withdrawFromGoal; window.deleteGoal = deleteGoal;
