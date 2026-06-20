// ==================== REUSABLE CRUD MODULE ====================
// createCrudModule({ resource, endpoint, fields, render, ... }) returns an
// object with standardized list / create / edit / delete behavior plus an
// accessible modal (role=dialog, aria-modal, focus trap, Esc to close).
//
// Goal: let future feature modules dedupe the modal + fetch boilerplate that
// currently repeats in goals.js / debts.js / subscriptions.js / etc.
//
// This module is ADDITIVE and OPT-IN. It does not touch existing modules.
// It reuses, when present:
//   - window.fetchWithAuth(url, options)  (auth'd fetch returning a Response)
//   - window.showNotification(msg, type)  (toast)
//   - window.a11y.trapFocus / announce    (focus trap + SR announce)
//   - window.i18n.t                       (translations)
// All of the above are feature-detected with safe fallbacks so the module
// works even if some are missing.
//
// Config:
//   resource   string  logical name (used in messages / DOM ids)
//   endpoint   string  base REST path, e.g. '/api/goals'
//   fields     array   [{ name, label, type='text', required, options,
//                          placeholder, min, max, step, value }]
//                      `options` = [{value,label}] for type 'select'.
//   render(item, ctx)  optional custom list-item renderer -> HTML string
//   idKey      string  primary key field on items (default 'id')
//   titleKey   string  field used as item title (default 'name')
//   labels     object  optional { create, edit } modal titles
//   onChange()         optional callback after any successful mutation
//
// Returned API:
//   list() -> Promise<item[]>
//   get(id) / create(data) / update(id,data) / remove(id)
//   openCreate() / openEdit(item) / closeModal()
//   buildFormHTML(item)   (pure-ish helper, exposed for tests/markup)

(function (root) {
  'use strict';

  // ---- tiny helpers with safe fallbacks ----
  function t(key, vars) {
    if (root.i18n && typeof root.i18n.t === 'function') return root.i18n.t(key, vars);
    return key;
  }

  function notify(msg, type) {
    if (typeof root.showNotification === 'function') {
      root.showNotification(msg, type || 'info');
    } else if (root.console) {
      (type === 'error' ? root.console.error : root.console.log)('[crud]', msg);
    }
  }

  function authedFetch(url, options) {
    if (typeof root.fetchWithAuth === 'function') return root.fetchWithAuth(url, options);
    // Fallback: plain fetch with a bearer token from localStorage.
    var opts = options || {};
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {}
    );
    try {
      var token = root.localStorage && root.localStorage.getItem('token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (e) { /* ignore */ }
    return root.fetch(url, Object.assign({}, opts, { headers: headers }));
  }

  // Escape text destined for innerHTML.
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Parse a Response (Foundation wraps as {success,data} or {success,error}).
  async function parseResponse(res) {
    var body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      var message =
        (body && body.error && body.error.message) ||
        (body && body.message) ||
        t('msg.error');
      var err = new Error(message);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    // Unwrap {success,data} envelope when present; else return raw body.
    if (body && typeof body === 'object' && 'data' in body && 'success' in body) {
      return body.data;
    }
    return body;
  }

  function createCrudModule(config) {
    config = config || {};
    var endpoint = config.endpoint;
    var resource = config.resource || 'item';
    var fields = Array.isArray(config.fields) ? config.fields : [];
    var idKey = config.idKey || 'id';
    var titleKey = config.titleKey || 'name';
    var labels = config.labels || {};

    if (!endpoint) {
      throw new Error('createCrudModule: `endpoint` is required');
    }

    var dialogIdSeq = 0;
    var releaseTrap = null;

    // ---------- data layer ----------
    async function list() {
      var res = await authedFetch(endpoint, { method: 'GET' });
      var data = await parseResponse(res);
      return Array.isArray(data) ? data : (data && data.items) || [];
    }

    async function get(id) {
      var res = await authedFetch(endpoint + '/' + encodeURIComponent(id), { method: 'GET' });
      return parseResponse(res);
    }

    async function create(data) {
      var res = await authedFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      var out = await parseResponse(res);
      if (typeof config.onChange === 'function') config.onChange('create', out);
      return out;
    }

    async function update(id, data) {
      var res = await authedFetch(endpoint + '/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(data)
      });
      var out = await parseResponse(res);
      if (typeof config.onChange === 'function') config.onChange('update', out);
      return out;
    }

    async function remove(id) {
      var res = await authedFetch(endpoint + '/' + encodeURIComponent(id), {
        method: 'DELETE'
      });
      var out = await parseResponse(res);
      if (typeof config.onChange === 'function') config.onChange('delete', { id: id });
      return out;
    }

    // ---------- form markup ----------
    function fieldHTML(field, item) {
      var name = field.name;
      var label = field.label || t('common.' + name) || name;
      var required = field.required ? ' required' : '';
      var value = item && item[name] != null ? item[name]
        : (field.value != null ? field.value : '');
      var ph = field.placeholder ? ' placeholder="' + esc(field.placeholder) + '"' : '';
      var fieldId = 'crud-field-' + esc(name);
      var control;

      if (field.type === 'select') {
        var opts = (field.options || []).map(function (o) {
          var sel = String(o.value) === String(value) ? ' selected' : '';
          return '<option value="' + esc(o.value) + '"' + sel + '>' + esc(o.label) + '</option>';
        }).join('');
        control = '<select id="' + fieldId + '" name="' + esc(name) +
          '" class="form-control"' + required + '>' + opts + '</select>';
      } else if (field.type === 'textarea') {
        control = '<textarea id="' + fieldId + '" name="' + esc(name) +
          '" class="form-control"' + required + ph + '>' + esc(value) + '</textarea>';
      } else {
        var numAttrs = '';
        if (field.type === 'number') {
          if (field.min != null) numAttrs += ' min="' + esc(field.min) + '"';
          if (field.max != null) numAttrs += ' max="' + esc(field.max) + '"';
          if (field.step != null) numAttrs += ' step="' + esc(field.step) + '"';
        }
        control = '<input id="' + fieldId + '" type="' + esc(field.type || 'text') +
          '" name="' + esc(name) + '" class="form-control" value="' + esc(value) + '"' +
          required + ph + numAttrs + '>';
      }

      return '<div class="form-group">' +
        '<label class="form-label" for="' + fieldId + '">' + esc(label) +
        (field.required ? ' <span aria-hidden="true">*</span>' : '') + '</label>' +
        control + '</div>';
    }

    // Build the inner <form> markup for create/edit. Pure given config+item.
    function buildFormHTML(item) {
      var rows = fields.map(function (f) { return fieldHTML(f, item); }).join('');
      return '<form id="crud-form-' + esc(resource) + '" novalidate>' + rows + '</form>';
    }

    function readForm(formEl) {
      var data = {};
      if (!formEl) return data;
      var fd = new FormData(formEl);
      fd.forEach(function (val, key) { data[key] = val; });
      // Coerce declared number fields.
      fields.forEach(function (f) {
        if (f.type === 'number' && data[f.name] !== undefined && data[f.name] !== '') {
          var n = parseFloat(data[f.name]);
          if (!isNaN(n)) data[f.name] = n;
        }
      });
      return data;
    }

    // ---------- modal ----------
    function closeModal() {
      if (releaseTrap) {
        try { releaseTrap(); } catch (e) { /* ignore */ }
        releaseTrap = null;
      }
      var existing = root.document &&
        root.document.getElementById('crud-modal-' + resource);
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    }

    function openModal(item) {
      if (!root.document || !root.document.body) return;
      closeModal();

      var isEdit = !!(item && item[idKey] != null);
      var titleId = 'crud-modal-title-' + resource + '-' + (++dialogIdSeq);
      var title = isEdit
        ? (labels.edit || t('btn.edit'))
        : (labels.create || t('btn.create'));

      var backdrop = root.document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.id = 'crud-modal-' + resource;

      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
          '<div class="modal-header">' +
            '<h2 class="modal-title" id="' + titleId + '">' + esc(title) + '</h2>' +
            '<button type="button" class="modal-close" data-crud-close ' +
              'aria-label="' + esc(t('btn.close')) + '">&times;</button>' +
          '</div>' +
          '<div class="modal-body">' + buildFormHTML(item) + '</div>' +
          '<div class="modal-footer">' +
            '<button type="button" class="btn btn-outline" data-crud-close>' +
              esc(t('btn.cancel')) + '</button>' +
            '<button type="button" class="btn btn-primary" data-crud-save>' +
              esc(isEdit ? t('btn.save') : t('btn.create')) + '</button>' +
          '</div>' +
        '</div>';

      root.document.body.appendChild(backdrop);

      var dialog = backdrop.querySelector('.modal');
      var formEl = backdrop.querySelector('#crud-form-' + resource);

      // Close handlers (buttons + backdrop click).
      var closers = backdrop.querySelectorAll('[data-crud-close]');
      for (var i = 0; i < closers.length; i++) {
        closers[i].addEventListener('click', closeModal);
      }
      backdrop.addEventListener('mousedown', function (e) {
        if (e.target === backdrop) closeModal();
      });

      // Save handler.
      var saveBtn = backdrop.querySelector('[data-crud-save]');
      if (saveBtn) {
        saveBtn.addEventListener('click', async function () {
          if (formEl && typeof formEl.reportValidity === 'function' && !formEl.reportValidity()) {
            return;
          }
          var data = readForm(formEl);
          saveBtn.disabled = true;
          try {
            if (isEdit) {
              await update(item[idKey], data);
              notify(t('msg.updated'), 'success');
            } else {
              await create(data);
              notify(t('msg.created'), 'success');
            }
            if (root.a11y && typeof root.a11y.announce === 'function') {
              root.a11y.announce(isEdit ? t('msg.updated') : t('msg.created'));
            }
            closeModal();
          } catch (err) {
            saveBtn.disabled = false;
            notify(err.message || t('msg.error'), 'error');
          }
        });
      }

      // Translate any data-i18n markup inside the freshly-built dialog.
      if (root.i18n && typeof root.i18n.translateDocument === 'function') {
        root.i18n.translateDocument(dialog);
      }

      // Engage focus trap (Esc closes).
      if (root.a11y && typeof root.a11y.trapFocus === 'function') {
        releaseTrap = root.a11y.trapFocus(dialog, { onEscape: closeModal });
      } else {
        // Minimal fallback: Esc-to-close + initial focus.
        var onKey = function (e) {
          if (e.key === 'Escape' || e.keyCode === 27) closeModal();
        };
        dialog.addEventListener('keydown', onKey);
        var firstInput = dialog.querySelector('input,select,textarea,button');
        if (firstInput && firstInput.focus) firstInput.focus();
        releaseTrap = function () { dialog.removeEventListener('keydown', onKey); };
      }

      return backdrop;
    }

    function openCreate() { return openModal(null); }
    function openEdit(item) { return openModal(item || {}); }

    async function deleteWithConfirm(id) {
      var confirmed = true;
      if (typeof root.confirm === 'function') {
        confirmed = root.confirm(t('msg.confirmDelete'));
      }
      if (!confirmed) return false;
      try {
        await remove(id);
        notify(t('msg.deleted'), 'success');
        if (root.a11y && typeof root.a11y.announce === 'function') {
          root.a11y.announce(t('msg.deleted'));
        }
        return true;
      } catch (err) {
        notify(err.message || t('msg.error'), 'error');
        return false;
      }
    }

    // Default list-item renderer (overridable via config.render).
    function renderItem(item, ctx) {
      if (typeof config.render === 'function') return config.render(item, ctx);
      var title = item[titleKey] != null ? item[titleKey] : item[idKey];
      return '<div class="card" data-crud-id="' + esc(item[idKey]) + '">' +
        '<div class="card-header">' +
          '<h3 class="card-title">' + esc(title) + '</h3>' +
        '</div></div>';
    }

    return {
      // data
      list: list,
      get: get,
      create: create,
      update: update,
      remove: remove,
      deleteWithConfirm: deleteWithConfirm,
      // ui
      openCreate: openCreate,
      openEdit: openEdit,
      closeModal: closeModal,
      buildFormHTML: buildFormHTML,
      renderItem: renderItem,
      // meta
      config: config,
      endpoint: endpoint,
      resource: resource
    };
  }

  var api = { createCrudModule: createCrudModule, _esc: esc, _parseResponse: parseResponse };

  if (typeof root !== 'undefined') {
    root.createCrudModule = createCrudModule;
    root.FinmanCrud = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
