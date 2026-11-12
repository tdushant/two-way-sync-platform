export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Local sync dashboard</title>
  <style>
    :root {
      --bg: #eef2f6;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --accent: #0f766e;
      --accent-ink: #042f2e;
      --accent-soft: #ccfbf1;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 24px rgba(15, 23, 42, 0.04);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(900px 280px at 0% -10%, #d1fae5 0%, transparent 60%),
        var(--bg);
      font: 15px/1.45 "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    .app { max-width: 1120px; margin: 0 auto; padding: 28px 20px 56px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; }
    .eyebrow { margin: 0; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 4px 0 0; font-size: 1.8rem; letter-spacing: -0.03em; }
    .lede { margin: 6px 0 0; max-width: 62ch; color: var(--muted); }
    #status { margin: 0; min-width: 220px; max-width: 320px; text-align: right; color: var(--accent-ink); font-weight: 600; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 18px; }
    .connection { margin-top: 18px; }
    .tabs, .subtabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tabs { margin: 18px 0 0; }
    .tabs button, .subtabs button, .actions button, button {
      font: 600 14px/1 "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      border-radius: 999px;
      border: 1px solid transparent;
      padding: 9px 14px;
      cursor: pointer;
    }
    .tabs button { background: transparent; color: var(--muted); }
    .tabs button[aria-selected="true"] { background: var(--ink); color: #fff; }
    .panel { margin-top: 14px; }
    .subtabs { margin-bottom: 14px; }
    .subtabs button { background: #f8fafc; color: var(--ink); border-color: var(--line); }
    .subtabs button[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-ink); border-color: #99f6e4; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .connection .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .stack { display: grid; gap: 14px; }
    label { display: grid; gap: 6px; margin: 0; color: var(--muted); font-size: 13px; font-weight: 650; }
    input, textarea, select {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #fff;
      color: var(--ink);
      padding: 9px 11px;
      font: 14px/1.3 "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    textarea { min-height: 88px; resize: vertical; }
    input:focus, textarea:focus, select:focus, button:focus-visible {
      outline: 2px solid #5eead4;
      outline-offset: 1px;
    }
    .checks { display: flex; gap: 18px; flex-wrap: wrap; margin: 4px 0 8px; }
    .checks label { display: flex; align-items: center; gap: 8px; color: var(--ink); }
    .checks input { width: auto; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .actions button { margin: 0; background: #fff; border-color: #cbd5e1; color: var(--ink); }
    .actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .note { margin: 0 0 12px; color: var(--muted); }
    .filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
    .count { margin: 0 0 10px; color: var(--muted); font-size: 13px; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 6px; font-size: 1.25rem; letter-spacing: -0.03em; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 9px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
    th { background: #f8fafc; color: var(--muted); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
    tr[data-delivery] { cursor: pointer; }
    tr[data-delivery]:hover td { background: #f0fdfa; }
    td.mono, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
    .empty { color: var(--muted); text-align: center; padding: 22px 10px; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 750; background: #e2e8f0; color: #334155; }
    .pill.PENDING, .pill.RETRY { background: #fef3c7; color: #92400e; }
    .pill.DELIVERING { background: #dbeafe; color: #1e40af; }
    .pill.DELIVERED, .pill.APPLIED { background: #d1fae5; color: #065f46; }
    .pill.FAILED, .pill.DEAD { background: #fee2e2; color: #991b1b; }
    pre { margin: 12px 0 0; white-space: pre-wrap; background: #0f172a; color: #e2e8f0; border-radius: 12px; padding: 12px; max-height: 280px; overflow: auto; font-size: 12px; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: var(--muted); font-weight: 650; }
    [hidden] { display: none !important; }
    @media (max-width: 860px) {
      header, .grid, .filters, .metrics { display: block; }
      #status { text-align: left; margin-top: 12px; }
      .filters label, .metrics .metric, .grid .card { margin-top: 10px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <p class="eyebrow">Portal and Fake Salesforce</p>
        <h1>Local sync dashboard</h1>
        <p class="lede">Edits and inspections go through the portal and Fake Salesforce HTTP APIs. This page reads and writes records. The servers decide conflicts, retries, echoes, and cursor movement.</p>
      </div>
      <p id="status" role="status"></p>
    </header>

    <section class="card connection">
      <div class="grid">
        <label>Portal actor<input id="actor" value="dev-user" /></label>
        <label>Simulator token<input id="token" value="local-simulator-token" /></label>
        <label>Fake Salesforce base URL<input id="fakeBase" value="http://127.0.0.1:3001" /></label>
      </div>
    </section>

    <div class="tabs" role="tablist" aria-label="Dashboard sections">
      <button type="button" role="tab" id="tab-contacts" data-group="main" data-tab="contacts" aria-controls="panel-contacts" aria-selected="true">Contacts</button>
      <button type="button" role="tab" id="tab-simulator" data-group="main" data-tab="simulator" aria-controls="panel-simulator" aria-selected="false">Simulator</button>
      <button type="button" role="tab" id="tab-sync" data-group="main" data-tab="sync" aria-controls="panel-sync" aria-selected="false">Sync</button>
      <button type="button" role="tab" id="tab-webhooks" data-group="main" data-tab="webhooks" aria-controls="panel-webhooks" aria-selected="false">Webhooks</button>
    </div>

    <section id="panel-contacts" class="panel" role="tabpanel" aria-labelledby="tab-contacts">
      <div class="grid">
        <div class="card">
          <h2>Portal contact</h2>
          <div class="stack">
            <label>Customer name<input id="customerName" value="Ada Co" /></label>
            <label>Full name<input id="fullName" value="Ada Lovelace" /></label>
            <label>Email<input id="email" value="ada@example.test" /></label>
            <label>Phone<input id="phone" value="555-0100" /></label>
            <label>City<input id="city" value="Paris" /></label>
            <label>Portal contact id<input id="portalContactId" /></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" id="createPortal">Create customer and contact</button>
            <button type="button" id="loadPortal">Load contact</button>
            <button type="button" id="savePortal">Save changed portal fields</button>
          </div>
          <pre id="portalOut"></pre>
        </div>
        <div class="card">
          <h2>Fake Salesforce contact</h2>
          <div class="stack">
            <label>Account name<input id="accountName" value="Remote Co" /></label>
            <label>City<input id="fakeCity" value="Nantes" /></label>
            <label>Phone<input id="fakePhone" value="555-0142" /></label>
            <label>Salesforce contact id<input id="fakeContactId" /></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" id="createFake">Create account and contact</button>
            <button type="button" id="saveFake">Save fake city and phone</button>
          </div>
          <pre id="fakeOut"></pre>
        </div>
      </div>
    </section>

    <section id="panel-simulator" class="panel card" role="tabpanel" aria-labelledby="tab-simulator" hidden>
      <h2>Simulator</h2>
      <p class="note">PUT replaces the whole simulator config. Duplicate count is extra copies of each delivery. Reorder lists event ids and leaves the change sequence as the server stored it.</p>
      <div class="checks">
        <label><input id="outage" type="checkbox" /> Outage enabled</label>
        <label><input id="webhooks" type="checkbox" checked /> Webhooks enabled</label>
      </div>
      <label>Duplicate count<input id="duplicates" type="number" min="0" value="0" /></label>
      <label>Event ids to reorder, one per line<textarea id="reorder" rows="3"></textarea></label>
      <div class="actions">
        <button type="button" class="primary" id="saveSim">Save simulator config</button>
        <button type="button" id="reorderBtn">Reorder deliveries</button>
        <button type="button" id="flushBtn">Flush deliveries</button>
      </div>
      <pre id="simOut"></pre>
    </section>

    <section id="panel-sync" class="panel card" role="tabpanel" aria-labelledby="tab-sync" hidden>
      <div class="actions" style="margin-top:0">
        <button type="button" class="primary" id="refresh">Refresh health, outbox, history, deliveries</button>
      </div>
      <div class="subtabs" role="tablist" aria-label="Sync inspection" style="margin-top:14px">
        <button type="button" role="tab" data-group="sync" data-tab="health" aria-controls="sync-health" aria-selected="true">Health and cursor</button>
        <button type="button" role="tab" data-group="sync" data-tab="outbox" aria-controls="sync-outbox" aria-selected="false">Outbox</button>
        <button type="button" role="tab" data-group="sync" data-tab="history" aria-controls="sync-history" aria-selected="false">History</button>
      </div>
      <div id="sync-health">
        <div id="healthCards" class="metrics"></div>
        <details><summary>Raw sync health</summary><pre id="healthOut"></pre></details>
      </div>
      <div id="sync-outbox" hidden>
        <div id="outboxTable"></div>
        <details><summary>Raw outbox</summary><pre id="outboxOut"></pre></details>
      </div>
      <div id="sync-history" hidden>
        <div id="historyTable"></div>
        <details><summary>Raw history</summary><pre id="historyOut"></pre></details>
      </div>
    </section>

    <section id="panel-webhooks" class="panel card" role="tabpanel" aria-labelledby="tab-webhooks" hidden>
      <div class="actions" style="margin-top:0">
        <button type="button" class="primary" id="refreshWebhooks">Refresh deliveries</button>
      </div>
      <div class="subtabs" role="tablist" aria-label="Webhook deliveries" style="margin-top:14px">
        <button type="button" role="tab" data-group="hooks" data-tab="recent" aria-controls="hooks-recent" aria-selected="true">Recent events</button>
        <button type="button" role="tab" data-group="hooks" data-tab="all" aria-controls="hooks-all" aria-selected="false">All events</button>
      </div>
      <div id="hooks-recent">
        <p class="note">Filters run in the browser on the list from <span class="mono">GET /simulator/deliveries</span>. The window uses each delivery's createdAt.</p>
        <div class="filters">
          <label>Window
            <select id="recentWindow">
              <option value="15">Last 15 minutes</option>
              <option value="60">Last hour</option>
              <option value="360">Last 6 hours</option>
              <option value="1440" selected>Last 24 hours</option>
              <option value="10080">Last 7 days</option>
            </select>
          </label>
          <label>Status
            <select id="recentStatus">
              <option value="">Any</option>
              <option value="PENDING">PENDING</option>
              <option value="DELIVERING">DELIVERING</option>
              <option value="DELIVERED">DELIVERED</option>
              <option value="FAILED">FAILED</option>
            </select>
          </label>
          <label>Object type<input id="recentObject" placeholder="Contact" /></label>
          <label>Event type<input id="recentType" placeholder="created" /></label>
          <label>Event id contains<input id="recentEventId" placeholder="event id" /></label>
        </div>
        <p id="recentCount" class="count"></p>
        <div id="recentTable" class="table-wrap"></div>
      </div>
      <div id="hooks-all" hidden>
        <p class="note">Every delivery returned by the API, in server order (scheduledAt, then id).</p>
        <p id="allCount" class="count"></p>
        <div id="allTable" class="table-wrap"></div>
      </div>
      <details open><summary>Selected delivery</summary><pre id="eventDetail">Select a row.</pre></details>
    </section>
  </div>

  <script>
    var loadedPortal = null;
    var deliveries = [];
    var deliveryById = {};
    var config = {
      outageEnabled: false,
      webhookEnabled: true,
      duplicateCount: 0,
      delayMs: 0,
      disorderMode: 'ordered',
      failureRate: 0,
      rateLimitPerSec: 1000,
      dropWebhookRate: 0,
      responseDelayMs: 0
    };

    function show(message) {
      document.getElementById('status').textContent = message;
    }

    function showJson(id, value) {
      document.getElementById(id).textContent = JSON.stringify(value, null, 2);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function settings() {
      return {
        actor: document.getElementById('actor').value.trim(),
        fake: document.getElementById('fakeBase').value.replace(/\\/$/, ''),
        token: document.getElementById('token').value.trim()
      };
    }

    function readBody(response) {
      return response.text().then(function (text) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (error) { return text; }
      });
    }

    function portal(path, options) {
      var current = settings();
      var headers = { 'content-type': 'application/json', 'x-actor-id': current.actor };
      if (options && options.headers) {
        Object.keys(options.headers).forEach(function (key) { headers[key] = options.headers[key]; });
      }
      return fetch(path, {
        method: options && options.method ? options.method : 'GET',
        headers: headers,
        body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
      }).then(function (response) {
        return readBody(response).then(function (body) {
          if (!response.ok) throw new Error(response.status + ' ' + JSON.stringify(body));
          return body;
        });
      });
    }

    function fake(path, options) {
      var current = settings();
      var headers = { 'content-type': 'application/json', 'x-simulator-token': current.token };
      if (options && options.headers) {
        Object.keys(options.headers).forEach(function (key) { headers[key] = options.headers[key]; });
      }
      return fetch(current.fake + path, {
        method: options && options.method ? options.method : 'GET',
        headers: headers,
        body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
      }).then(function (response) {
        return readBody(response).then(function (body) {
          if (!response.ok) throw new Error(response.status + ' ' + JSON.stringify(body));
          return body;
        });
      });
    }

    function selectGroup(group, name) {
      document.querySelectorAll('[data-group="' + group + '"]').forEach(function (button) {
        var on = button.getAttribute('data-tab') === name;
        button.setAttribute('aria-selected', on ? 'true' : 'false');
        var panel = document.getElementById(button.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    }

    document.querySelectorAll('[data-group]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectGroup(button.getAttribute('data-group'), button.getAttribute('data-tab'));
      });
    });

    function changedPortalFields(contact) {
      var next = {};
      ['fullName', 'email', 'phone', 'city'].forEach(function (field) {
        var value = document.getElementById(field).value;
        if (value !== (contact[field] || '')) next[field] = value;
      });
      return next;
    }

    function readConfigFromForm() {
      config.outageEnabled = document.getElementById('outage').checked;
      config.webhookEnabled = document.getElementById('webhooks').checked;
      config.duplicateCount = Number(document.getElementById('duplicates').value || '0');
      return config;
    }

    function pill(status) {
      var name = String(status || '').replace(/[^A-Za-z_]/g, '');
      return '<span class="pill ' + name + '">' + escapeHtml(status || '') + '</span>';
    }

    function shortTime(value) {
      if (!value) return '';
      return String(value).replace('T', ' ').replace(/\\.\\d+Z$/, 'Z');
    }

    function payloadOf(row) {
      return row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    }

    function table(columns, rows, emptyText, rowId) {
      var html = '<table><thead><tr>';
      columns.forEach(function (column) { html += '<th>' + escapeHtml(column.label) + '</th>'; });
      html += '</tr></thead><tbody>';
      if (!rows.length) {
        html += '<tr><td class="empty" colspan="' + columns.length + '">' + escapeHtml(emptyText) + '</td></tr>';
      }
      rows.forEach(function (row) {
        html += '<tr' + (rowId ? ' data-delivery="' + escapeHtml(row[rowId]) + '"' : '') + '>';
        columns.forEach(function (column) {
          var value = column.render ? column.render(row) : escapeHtml(row[column.key]);
          html += '<td class="' + (column.mono ? 'mono' : '') + '">' + value + '</td>';
        });
        html += '</tr>';
      });
      return html + '</tbody></table>';
    }

    function renderHealth(body) {
      showJson('healthOut', body);
      var fields = [
        ['checkpointCursor', 'Reconciliation cursor'],
        ['reconciliationLagSeconds', 'Reconciliation lag (s)'],
        ['outboxPending', 'Outbox pending'],
        ['outboxOldestAgeSeconds', 'Oldest outbox age (s)'],
        ['deadLetterTotal', 'Dead letters'],
        ['workerObserved', 'Worker observed']
      ];
      document.getElementById('healthCards').innerHTML = fields.map(function (field) {
        return '<div class="metric"><span>' + escapeHtml(field[1]) + '</span><strong>' + escapeHtml(body && body[field[0]]) + '</strong></div>';
      }).join('');
    }

    function renderOutbox(body) {
      showJson('outboxOut', body);
      var items = body && Array.isArray(body.items) ? body.items : [];
      document.getElementById('outboxTable').innerHTML = table([
        { label: 'Status', render: function (row) { return pill(row.status); } },
        { label: 'Type', key: 'eventType' },
        { label: 'Entity', key: 'entityType' },
        { label: 'Attempts', key: 'attempts' },
        { label: 'Last error', key: 'lastError' },
        { label: 'Updated', render: function (row) { return escapeHtml(shortTime(row.updatedAt)); } },
        { label: 'Operation', key: 'operationId', mono: true }
      ], items, 'No outbox rows.');
    }

    function renderHistory(body) {
      showJson('historyOut', body);
      var items = body && Array.isArray(body.items) ? body.items : [];
      document.getElementById('historyTable').innerHTML = table([
        { label: 'Applied', render: function (row) { return escapeHtml(shortTime(row.appliedAt)); } },
        { label: 'Field', key: 'fieldName' },
        { label: 'Decision', render: function (row) { return pill(row.decision); } },
        { label: 'Old', key: 'oldValue' },
        { label: 'New', key: 'newValue' },
        { label: 'Source', key: 'source' },
        { label: 'Actor', key: 'actorId' }
      ], items, 'No history rows. Load a portal contact, then refresh.');
    }

    function deliveryColumns() {
      return [
        { label: 'Created', render: function (row) { return escapeHtml(shortTime(row.createdAt)); } },
        { label: 'Status', render: function (row) { return pill(row.status); } },
        { label: 'Object', render: function (row) { return escapeHtml(payloadOf(row).objectType || ''); } },
        { label: 'Event', render: function (row) { return escapeHtml(payloadOf(row).eventType || ''); } },
        { label: 'Event id', key: 'eventId', mono: true },
        { label: 'Attempts', key: 'attempts' },
        { label: 'HTTP', key: 'lastHttpStatus' }
      ];
    }

    function filteredDeliveries() {
      var minutes = Number(document.getElementById('recentWindow').value || '1440');
      var status = document.getElementById('recentStatus').value;
      var objectType = document.getElementById('recentObject').value.trim().toLowerCase();
      var eventType = document.getElementById('recentType').value.trim().toLowerCase();
      var eventId = document.getElementById('recentEventId').value.trim().toLowerCase();
      var cutoff = Date.now() - minutes * 60 * 1000;
      return deliveries.filter(function (row) {
        var created = Date.parse(row.createdAt);
        if (!Number.isFinite(created) || created < cutoff) return false;
        if (status && row.status !== status) return false;
        var payload = payloadOf(row);
        if (objectType && String(payload.objectType || '').toLowerCase().indexOf(objectType) === -1) return false;
        if (eventType && String(payload.eventType || '').toLowerCase().indexOf(eventType) === -1) return false;
        if (eventId && String(row.eventId || '').toLowerCase().indexOf(eventId) === -1) return false;
        return true;
      }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
    }

    function renderDeliveries() {
      var recent = filteredDeliveries();
      document.getElementById('recentCount').textContent = recent.length + ' of ' + deliveries.length + ' deliveries';
      document.getElementById('recentTable').innerHTML = table(deliveryColumns(), recent, 'No deliveries match these filters.', 'id');
      document.getElementById('allCount').textContent = deliveries.length + ' deliveries';
      document.getElementById('allTable').innerHTML = table(deliveryColumns(), deliveries, 'No deliveries loaded.', 'id');
    }

    function rememberDeliveries(rows) {
      deliveries = Array.isArray(rows) ? rows : [];
      deliveryById = {};
      deliveries.forEach(function (row) { deliveryById[row.id] = row; });
      renderDeliveries();
    }

    document.getElementById('panel-webhooks').addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('tr[data-delivery]') : null;
      if (!target) return;
      var row = deliveryById[target.getAttribute('data-delivery')];
      if (row) showJson('eventDetail', row);
    });

    ['recentWindow', 'recentStatus', 'recentObject', 'recentType', 'recentEventId'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderDeliveries);
      document.getElementById(id).addEventListener('change', renderDeliveries);
    });

    document.getElementById('createPortal').onclick = function () {
      show('Creating portal records...');
      portal('/api/v1/customers', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { name: document.getElementById('customerName').value }
      }).then(function (customer) {
        return portal('/api/v1/contacts', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: {
            customerId: customer.id,
            fullName: document.getElementById('fullName').value,
            email: document.getElementById('email').value,
            phone: document.getElementById('phone').value,
            city: document.getElementById('city').value
          }
        });
      }).then(function (contact) {
        loadedPortal = contact;
        document.getElementById('portalContactId').value = contact.id;
        showJson('portalOut', contact);
        show('Portal contact created.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('loadPortal').onclick = function () {
      var id = document.getElementById('portalContactId').value.trim();
      portal('/api/v1/contacts/' + id).then(function (contact) {
        loadedPortal = contact;
        document.getElementById('fullName').value = contact.fullName || '';
        document.getElementById('email').value = contact.email || '';
        document.getElementById('phone').value = contact.phone || '';
        document.getElementById('city').value = contact.city || '';
        showJson('portalOut', contact);
        show('Portal contact loaded.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('savePortal').onclick = function () {
      if (!loadedPortal) { show('Load the portal contact first.'); return; }
      var fields = changedPortalFields(loadedPortal);
      if (Object.keys(fields).length === 0) { show('No portal fields changed.'); return; }
      portal('/api/v1/contacts/' + loadedPortal.id, {
        method: 'PATCH',
        headers: { 'If-Match': String(loadedPortal.rowVersion) },
        body: fields
      }).then(function (contact) {
        loadedPortal = contact;
        showJson('portalOut', contact);
        show('Portal contact saved.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('createFake').onclick = function () {
      show('Creating fake Salesforce records...');
      fake('/sf/v1/accounts', {
        method: 'POST',
        headers: { 'x-changed-by': 'dashboard' },
        body: { name: document.getElementById('accountName').value }
      }).then(function (account) {
        return fake('/sf/v1/contacts', {
          method: 'POST',
          headers: { 'x-changed-by': 'dashboard' },
          body: {
            accountId: account.id,
            fullName: document.getElementById('fullName').value,
            phone: document.getElementById('fakePhone').value,
            city: document.getElementById('fakeCity').value
          }
        });
      }).then(function (contact) {
        document.getElementById('fakeContactId').value = contact.id;
        showJson('fakeOut', contact);
        show('Fake contact created.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('saveFake').onclick = function () {
      var id = document.getElementById('fakeContactId').value.trim();
      fake('/sf/v1/contacts/' + id, {
        method: 'PATCH',
        headers: { 'x-changed-by': 'dashboard' },
        body: {
          phone: document.getElementById('fakePhone').value,
          city: document.getElementById('fakeCity').value
        }
      }).then(function (contact) {
        showJson('fakeOut', contact);
        show('Fake contact saved.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('saveSim').onclick = function () {
      fake('/simulator/config', { method: 'PUT', body: readConfigFromForm() }).then(function (saved) {
        config = saved;
        showJson('simOut', saved);
        show('Simulator config saved.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('reorderBtn').onclick = function () {
      var eventIds = document.getElementById('reorder').value.split(/\\s+/).filter(Boolean);
      fake('/simulator/reorder-deliveries', { method: 'POST', body: { eventIds: eventIds } }).then(function (body) {
        showJson('simOut', body);
        show('Deliveries reordered.');
      }).catch(function (error) { show(error.message); });
    };

    document.getElementById('flushBtn').onclick = function () {
      fake('/simulator/flush-deliveries', { method: 'POST' }).then(function (body) {
        showJson('simOut', body);
        show('Deliveries flushed.');
      }).catch(function (error) { show(error.message); });
    };

    function refreshAll() {
      var contactId = document.getElementById('portalContactId').value.trim();
      var history = contactId
        ? portal('/api/v1/contacts/' + contactId + '/history')
        : Promise.resolve({ items: [], nextCursor: null });
      show('Refreshing...');
      return Promise.all([
        portal('/api/v1/sync/health'),
        portal('/api/v1/sync/outbox'),
        history,
        fake('/simulator/deliveries')
      ]).then(function (parts) {
        renderHealth(parts[0]);
        renderOutbox(parts[1]);
        renderHistory(parts[2]);
        rememberDeliveries(parts[3]);
        show('Inspection refreshed. Cursor is checkpointCursor on sync health.');
      }).catch(function (error) { show(error.message); });
    }

    document.getElementById('refresh').onclick = refreshAll;
    document.getElementById('refreshWebhooks').onclick = function () {
      selectGroup('main', 'webhooks');
      refreshAll();
    };
    renderDeliveries();
  </script>
</body>
</html>`;
