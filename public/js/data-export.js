// public/js/data-export.js — backup / restore / export UI (wave-2 "export-backup").
//
// Self-contained settings panel for full data portability:
//   - Download a complete JSON backup        (GET  /api/export/backup)
//   - Download an "everything" CSV           (GET  /api/export/csv)
//   - Restore from a JSON backup file        (POST /api/export/restore)
//
// The module is defensive: it feature-detects shared helpers from app.js
// (showNotification, fetchWithAuth) and falls back to plain fetch + console so
// it works even if loaded before app.js or on a page without those globals.
// It mounts itself into a container with id="data-export-panel" if present,
// otherwise it exposes window.DataExportModule for manual mounting.

(function () {
  'use strict';

  function token() {
    try {
      return localStorage.getItem('token') || '';
    } catch (e) {
      return '';
    }
  }

  function notify(msg, type) {
    if (typeof showNotification === 'function') return showNotification(msg, type);
    try {
      console[type === 'error' ? 'error' : 'log']('[data-export]', msg);
    } catch (e) {
      /* noop */
    }
  }

  function authHeaders(extra) {
    return Object.assign(
      { Authorization: 'Bearer ' + token() },
      extra || {}
    );
  }

  // Trigger a browser download from a fetch Response, preserving the
  // server-provided filename when present.
  async function downloadResponse(response, fallbackName) {
    if (!response.ok) {
      let msg = 'Ошибка экспорта (' + response.status + ')';
      try {
        const body = await response.json();
        if (body && body.error && body.error.message) msg = body.error.message;
      } catch (e) {
        /* not json */
      }
      throw new Error(msg);
    }
    const blob = await response.blob();
    let filename = fallbackName;
    const cd = response.headers.get('Content-Disposition');
    if (cd) {
      const m = /filename="?([^";]+)"?/.exec(cd);
      if (m) filename = m[1];
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const DataExportModule = {
    async downloadBackup() {
      try {
        const res = await fetch('/api/export/backup', { headers: authHeaders() });
        await downloadResponse(res, 'finman_full_backup.json');
        notify('Резервная копия скачана', 'success');
      } catch (e) {
        notify(e.message || 'Не удалось скачать резервную копию', 'error');
      }
    },

    async downloadCsv() {
      try {
        const res = await fetch('/api/export/csv', { headers: authHeaders() });
        await downloadResponse(res, 'finman_all_data.csv');
        notify('CSV выгружен', 'success');
      } catch (e) {
        notify(e.message || 'Не удалось выгрузить CSV', 'error');
      }
    },

    async restoreFromFile(file) {
      if (!file) {
        notify('Выберите файл резервной копии (.json)', 'error');
        return;
      }
      let parsed;
      try {
        const text = await file.text();
        parsed = JSON.parse(text);
      } catch (e) {
        notify('Файл повреждён или это не JSON', 'error');
        return;
      }
      try {
        const res = await fetch('/api/export/restore', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(parsed),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || (body && body.success === false)) {
          const msg =
            (body && body.error && body.error.message) ||
            'Ошибка восстановления (' + res.status + ')';
          throw new Error(msg);
        }
        const data = (body && body.data) || {};
        const count = data.totalImported != null ? data.totalImported : '?';
        notify('Восстановлено записей: ' + count, 'success');
        // Дайте остальным модулям шанс перечитать данные.
        try {
          document.dispatchEvent(new CustomEvent('finman:data-restored', { detail: data }));
        } catch (e) {
          /* CustomEvent may be unavailable in very old engines */
        }
      } catch (e) {
        notify(e.message || 'Не удалось восстановить данные', 'error');
      }
    },

    // Build the settings panel markup and wire up events.
    render(container) {
      if (!container) return;
      container.innerHTML = [
        '<div class="data-export card">',
        '  <h3>Экспорт и резервные копии</h3>',
        '  <p class="muted">Скачайте полную копию всех данных или восстановите их из файла.</p>',
        '  <div class="data-export-actions">',
        '    <button type="button" id="btn-backup-json" class="btn btn-primary">Скачать резервную копию (JSON)</button>',
        '    <button type="button" id="btn-backup-csv" class="btn btn-secondary">Выгрузить всё в CSV</button>',
        '  </div>',
        '  <div class="data-export-restore">',
        '    <label for="restore-file">Восстановить из резервной копии:</label>',
        '    <input type="file" id="restore-file" accept="application/json,.json" />',
        '    <button type="button" id="btn-restore" class="btn btn-warning">Восстановить</button>',
        '  </div>',
        '</div>',
      ].join('\n');

      const byId = (id) => container.querySelector('#' + id);

      const backupBtn = byId('btn-backup-json');
      if (backupBtn) backupBtn.addEventListener('click', () => this.downloadBackup());

      const csvBtn = byId('btn-backup-csv');
      if (csvBtn) csvBtn.addEventListener('click', () => this.downloadCsv());

      const restoreBtn = byId('btn-restore');
      const fileInput = byId('restore-file');
      if (restoreBtn && fileInput) {
        restoreBtn.addEventListener('click', () => {
          const file = fileInput.files && fileInput.files[0];
          this.restoreFromFile(file);
        });
      }
    },

    init() {
      const container =
        document.getElementById('data-export-panel') ||
        document.querySelector('[data-export-panel]');
      if (container) this.render(container);
    },
  };

  // Expose for manual mounting / tests.
  window.DataExportModule = DataExportModule;

  // Auto-init when the DOM is ready (no-op if the container is absent).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => DataExportModule.init());
  } else {
    DataExportModule.init();
  }
})();
