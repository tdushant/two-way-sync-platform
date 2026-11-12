export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Local sync dashboard</title>
  <style>
    body { font-family: Georgia, serif; margin: 24px auto; max-width: 980px; color: #1c1917; background: #f7f4ef; }
    h1 { font-size: 1.7rem; margin-bottom: 0.2rem; }
    h2 { font-size: 1.15rem; margin: 0 0 8px; }
    section { background: #fff; border: 1px solid #e7e5e4; padding: 16px 18px; margin: 14px 0; }
    p { line-height: 1.4; }
    .note { color: #57534e; }
    label { display: block; margin: 8px 0 4px; }
    input, textarea, button { font: 16px ui-sans-serif, sans-serif; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; }
    button { margin: 10px 8px 0 0; padding: 6px 12px; cursor: pointer; }
    pre { white-space: pre-wrap; background: #f5f5f4; padding: 8px; max-height: 260px; overflow: auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    #status { min-height: 1.2em; }
  </style>
</head>
<body>
  <h1>Local sync dashboard</h1>
  <p class="note">Edits and inspections go through the portal and Fake Salesforce HTTP APIs. This page does not decide conflicts, retries, echoes, or cursor movement.</p>
  <p id="status" role="status"></p>

  <section>
    <h2>Connection</h2>
    <div class="grid">
      <label>Portal actor<input id="actor" value="dev-user" /></label>
      <label>Simulator token<input id="token" value="local-simulator-token" /></label>
    </div>
    <label>Fake Salesforce base URL<input id="fakeBase" value="http://127.0.0.1:3001" /></label>
  </section>

  <section>
    <h2>Portal contact</h2>
    <div class="grid">
      <label>Customer name<input id="customerName" value="Ada Co" /></label>
      <label>Full name<input id="fullName" value="Ada Lovelace" /></label>
      <label>Email<input id="email" value="ada@example.test" /></label>
      <label>Phone<input id="phone" value="555-0100" /></label>
      <label>City<input id="city" value="Paris" /></label>
      <label>Portal contact id<input id="portalContactId" /></label>
    </div>
    <button type="button" id="createPortal">Create customer and contact</button>
    <button type="button" id="loadPortal">Load contact</button>
    <button type="button" id="savePortal">Save changed portal fields</button>
    <pre id="portalOut"></pre>
  </section>

  <section>
    <h2>Fake Salesforce contact</h2>
    <div class="grid">
      <label>Account name<input id="accountName" value="Remote Co" /></label>
      <label>City<input id="fakeCity" value="Nantes" /></label>
      <label>Phone<input id="fakePhone" value="555-0142" /></label>
      <label>Salesforce contact id<input id="fakeContactId" /></label>
    </div>
    <button type="button" id="createFake">Create account and contact</button>
    <button type="button" id="saveFake">Save fake city and phone</button>
    <pre id="fakeOut"></pre>
  </section>

  <section>
    <h2>Simulator</h2>
    <p class="note">PUT replaces the whole simulator config. Duplicate count is extra copies of each delivery. Reorder lists event ids and does not rewrite the change sequence.</p>
    <label><input id="outage" type="checkbox" /> Outage enabled</label>
    <label><input id="webhooks" type="checkbox" checked /> Webhooks enabled</label>
    <label>Duplicate count<input id="duplicates" type="number" min="0" value="0" /></label>
    <label>Event ids to reorder, one per line<textarea id="reorder" rows="3"></textarea></label>
    <button type="button" id="saveSim">Save simulator config</button>
    <button type="button" id="reorderBtn">Reorder deliveries</button>
    <button type="button" id="flushBtn">Flush deliveries</button>
    <pre id="simOut"></pre>
  </section>

  <section>
    <h2>Inspection</h2>
    <button type="button" id="refresh">Refresh health, outbox, history, deliveries</button>
    <h3>Sync health and reconciliation cursor</h3>
    <pre id="healthOut"></pre>
    <h3>Outbox</h3>
    <pre id="outboxOut"></pre>
    <h3>Portal contact history</h3>
    <pre id="historyOut"></pre>
    <h3>Webhook deliveries</h3>
    <pre id="deliveriesOut"></pre>
  </section>

  <script>
    var loadedPortal = null;
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

    document.getElementById('refresh').onclick = function () {
      var contactId = document.getElementById('portalContactId').value.trim();
      var history = contactId
        ? portal('/api/v1/contacts/' + contactId + '/history')
        : Promise.resolve({ items: [], nextCursor: null });
      Promise.all([
        portal('/api/v1/sync/health'),
        portal('/api/v1/sync/outbox'),
        history,
        fake('/simulator/deliveries')
      ]).then(function (parts) {
        showJson('healthOut', parts[0]);
        showJson('outboxOut', parts[1]);
        showJson('historyOut', parts[2]);
        showJson('deliveriesOut', parts[3]);
        show('Inspection refreshed. Cursor is checkpointCursor on sync health.');
      }).catch(function (error) { show(error.message); });
    };
  </script>
</body>
</html>`;
