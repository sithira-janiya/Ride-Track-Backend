// RideTrack admin panel: a small dependency-free SPA over /api/v1, for admins and authority officers.
// Admins sign in through /admin/auth and also manage accounts; officers use the app sign-in.
// All user data is rendered with textContent (via `h`), never innerHTML.

const API = '/api/v1';
const $ = (sel) => document.querySelector(sel);

// ---------- session ----------

const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let session = { access: store.get('rt.access'), refresh: store.get('rt.refresh'), user: JSON.parse(store.get('rt.user') || 'null') };

function saveSession(s) {
  session = { ...session, ...s };
  store.set('rt.access', session.access);
  store.set('rt.refresh', session.refresh);
  store.set('rt.user', session.user ? JSON.stringify(session.user) : null);
}

const PANEL_ROLES = ['ADMIN', 'AUTHORITY'];
const isAdmin = () => session.user?.role === 'ADMIN';
// admin sessions use their own sign-in, refresh and logout endpoints
const authPath = (action) => `${isAdmin() ? '/admin/auth' : '/auth'}/${action}`;

function logout() {
  // ends the admin session on the server too; app sessions simply lapse
  if (isAdmin() && session.refresh) {
    fetch(`${API}/admin/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refresh }) }).catch(() => {});
  }
  saveSession({ access: null, refresh: null, user: null });
  showLogin();
}

let refreshing = null;
async function refreshTokens() {
  refreshing ??= fetch(`${API}${authPath('refresh')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refresh }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error('refresh failed');
      const { data } = await r.json();
      saveSession({ access: data.accessToken, refresh: data.refreshToken });
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

/** Calls the API; refreshes an expired access token once; throws Error(message) on failure. */
async function api(path, { method = 'GET', body, query } = {}, retried = false) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null))}` : '';
  const res = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session.access ? { authorization: `Bearer ${session.access}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !retried && session.refresh && !/^\/(admin\/)?auth\//.test(path)) {
    try {
      await refreshTokens();
      return api(path, { method, body, query }, true);
    } catch {
      logout();
      throw new Error('Your session has expired. Please sign in again.');
    }
  }
  if (res.status === 401) { logout(); throw new Error(json.error?.message || 'Please sign in again.'); }
  if (!res.ok) throw new Error(json.error?.message || `Request failed (${res.status})`);
  return json.data;
}

// ---------- DOM helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
// timeZone: the route's, so Dubai and Sri Lanka trips each show their own local time
const fmtClock = (iso, timeZone) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone }) : '—');
const fmtMoney = (n, currency = 'LKR') => `${currency} ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const REGION = { SRI_LANKA: 'Sri Lanka', DUBAI: 'Dubai' };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const TONE = {
  ACTIVE: 'ok', PAID: 'ok', ONGOING: 'ok', COMPLETED: '', USED: '', SCHEDULED: '',
  PENDING: 'warn', DELAYED: 'warn', ROUTE_CHANGE: 'warn', DELAY: 'warn',
  CANCELLED: 'bad', CANCELLATION: 'bad', EXPIRED: 'bad', FAILED: 'bad', REFUNDED: 'warn', DISABLED: 'bad',
};
const badge = (text, tone = TONE[text] ?? '') => h('span', { class: `badge ${tone}` }, text ?? '—');

/**
 * Renders a table. columns: [{ label, value: row => node|string, num?, wrap? }]
 * Each cell carries its column label (data-label), so on a phone the CSS can show every row as a small card.
 */
function table(columns, rows, emptyText = 'Nothing to show.') {
  if (!rows.length) return h('div', { class: 'card empty' }, emptyText);
  return h(
    'div',
    { class: 'card table-wrap' },
    h(
      'table',
      { class: 'responsive' },
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '', scope: 'col' }, c.label)))),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h('tr', {}, columns.map((c) => h('td', { class: [c.num && 'num', c.wrap && 'wrap'].filter(Boolean).join(' '), 'data-label': c.label }, c.value(r)))),
        ),
      ),
    ),
  );
}

const stat = (label, value, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub && h('div', { class: 'sub' }, sub));

let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- modal form ----------

/**
 * Opens a form dialog. fields: [{ name, label, type?, options?: [[value, label]], value?, required?, full?, min?, max?, step? }]
 * onSubmit(values) may throw; its message is shown in the dialog.
 */
function openForm(title, fields, onSubmit, submitLabel = 'Save') {
  const dialog = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-submit').textContent = submitLabel;
  const err = $('#modal-error');
  err.hidden = true;
  const body = $('#modal-body');
  body.replaceChildren(
    ...fields.map((f) => {
      let input;
      if (f.options) {
        input = h('select', { name: f.name, required: f.required }, f.options.map(([v, l]) => h('option', { value: v, selected: String(f.value ?? '') === String(v) }, l)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { name: f.name, required: f.required, rows: 3, maxlength: f.max });
        input.value = f.value ?? '';
      } else {
        input = h('input', { name: f.name, type: f.type ?? 'text', required: f.required, min: f.min, max: f.max, step: f.step, value: f.value ?? '', autocomplete: 'off' });
      }
      return h('label', { class: f.full ? 'full' : '' }, f.label, input);
    }),
  );
  const form = $('#modal-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const raw = form.elements[f.name].value.trim();
      if (raw === '') continue;
      values[f.name] = f.type === 'number' ? Number(raw) : f.type === 'datetime-local' ? new Date(raw).toISOString() : raw;
    }
    $('#modal-submit').disabled = true;
    try {
      await onSubmit(values);
      dialog.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      $('#modal-submit').disabled = false;
    }
  };
  $('#modal-cancel').onclick = () => dialog.close();
  dialog.showModal();
  body.querySelector('input, select, textarea')?.focus();
}

// ---------- pages ----------

let routesCache = null;
async function routes(force = false) {
  if (!routesCache || force) routesCache = await api('/admin/routes');
  return routesCache;
}
const routeOptions = async (blank) => [...(blank ? [['', blank]] : []), ...(await routes()).map((r) => [r.routeId, `${r.routeNo} · ${r.name}${r.isActive ? '' : ' (inactive)'}`])];

const pages = {
  async overview(page, actions) {
    actions.append(h('button', { onclick: () => render() }, 'Refresh'));
    const [o, dash] = await Promise.all([api('/admin/overview'), api('/ops/dashboard')]);
    const occ = dash.occupancy.totalCapacity ? Math.round((dash.occupancy.totalPassengers / dash.occupancy.totalCapacity) * 100) : 0;
    page.append(
      h(
        'div',
        { class: 'stats' },
        stat('Users', o.users.total, `${o.users.passengers} passengers · ${o.users.staff} staff · ${o.users.officers} officers · ${o.users.admins} admins`),
        stat('Fleet', o.fleet.vehicles, `${o.fleet.routes} active routes · ${o.fleet.stops} stops`),
        stat('Trips today', o.tripsToday.total, `${o.tripsToday.ongoing} ongoing · ${o.tripsToday.delayed} delayed · ${o.tripsToday.cancelled} cancelled`),
        stat('Sales today', o.salesToday.byCurrency.map((c) => fmtMoney(c.revenue, c.currency)).join(' + ') || fmtMoney(0), `${o.salesToday.tickets} paid tickets`),
        stat('Live vehicles', dash.vehicles.length, `${occ}% seats taken · ${dash.occupancy.fullVehicles} near full`),
      ),
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          {},
          h('h3', { class: 'section-title' }, 'Live vehicles'),
          table(
            [
              { label: 'Route', value: (v) => `${v.routeNo} (${v.mode})` },
              { label: 'Vehicle', value: (v) => v.regNo },
              { label: 'Next stop ETA', value: (v) => fmtClock(v.eta) },
              {
                label: 'Load',
                value: (v) => {
                  const pct = v.capacity ? Math.min(100, Math.round(((v.passengerCount ?? 0) / v.capacity) * 100)) : 0;
                  return h('div', { class: `bar${pct >= 90 ? ' full' : ''}`, title: `${v.passengerCount ?? 0}/${v.capacity}` }, h('span', { style: `width:${pct}%` }));
                },
              },
              { label: 'Last ping', value: (v) => fmtClock(v.recordedAt) },
            ],
            dash.vehicles,
            'No vehicles are reporting right now.',
          ),
        ),
        h(
          'div',
          {},
          h('h3', { class: 'section-title' }, 'Delays & cancellations (12 h)'),
          table(
            [
              { label: 'Type', value: (a) => badge(a.type) },
              { label: 'Trip', value: (a) => `#${a.tripId}` },
              { label: 'Message', value: (a) => a.message, wrap: true },
              { label: 'When', value: (a) => fmtClock(a.createdAt) },
            ],
            dash.activeDelays,
            'No recent delays.',
          ),
        ),
      ),
    );
  },

  async users(page, actions, state) {
    state.page ??= 1;
    actions.append(h('button', { class: 'primary', onclick: () => newStaffForm() }, 'New account'));
    const q = h('input', { type: 'search', placeholder: 'Search name, email, phone', value: state.q ?? '' });
    const role = h('select', {}, [['', 'All roles'], ['PASSENGER', 'Passengers'], ['STAFF', 'Staff'], ['AUTHORITY', 'Officers'], ['ADMIN', 'Admins']].map(([v, l]) => h('option', { value: v, selected: (state.role ?? '') === v }, l)));
    const apply = () => { Object.assign(state, { q: q.value.trim(), role: role.value, page: 1 }); render(); };
    q.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
    role.addEventListener('change', apply);
    page.append(h('div', { class: 'toolbar' }, q, role, h('button', { onclick: apply }, 'Search')));

    const limit = 25;
    const { users, total } = await api('/admin/users', { query: { q: state.q, role: state.role, page: state.page, limit } });
    const toggle = async (u) => {
      if (u.isActive && !confirm(`Disable ${u.name}? They will be signed out and cannot log in.`)) return;
      await api(`/admin/users/${u.userId}`, { method: 'PATCH', body: { isActive: !u.isActive } }).then(
        () => (toast(u.isActive ? 'Account disabled.' : 'Account enabled.'), render()),
        (e) => toast(e.message, true),
      );
    };
    const assign = async (u) => {
      const vehicles = await api('/admin/vehicles');
      openForm(`Assign vehicle · ${u.name}`, [
        { name: 'vehicleId', label: 'Vehicle', full: true, value: u.vehicleId ?? '', options: [['', 'None'], ...vehicles.filter((v) => v.isActive).map((v) => [v.vehicleId, `${v.regNo} · route ${v.routeNo}`])] },
      ], async (v) => {
        await api(`/admin/users/${u.userId}`, { method: 'PATCH', body: { vehicleId: v.vehicleId ? Number(v.vehicleId) : null } });
        toast('Vehicle assigned.');
        render();
      });
    };
    page.append(
      table(
        [
          { label: 'ID', value: (u) => u.userId, num: true },
          { label: 'Name', value: (u) => u.name },
          { label: 'Email / phone', value: (u) => [u.email, u.phone].filter(Boolean).join(' · ') },
          { label: 'Role', value: (u) => badge(u.role) },
          { label: 'Details', value: (u) => [u.employeeNo, u.staffType, u.organisation, u.vehicleId && `vehicle ${u.vehicleId}`].filter(Boolean).join(' · ') || '—', wrap: true },
          { label: 'Joined', value: (u) => (u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—') },
          { label: 'Status', value: (u) => (u.isActive ? badge('ACTIVE') : badge('DISABLED')) },
          {
            label: '',
            value: (u) =>
              h(
                'div',
                { class: 'actions' },
                u.role === 'STAFF' && h('button', { class: 'small', onclick: () => assign(u) }, 'Vehicle'),
                u.userId !== session.user?.userId && h('button', { class: `small${u.isActive ? ' danger' : ''}`, onclick: () => toggle(u) }, u.isActive ? 'Disable' : 'Enable'),
              ),
          },
        ],
        users,
        'No users match.',
      ),
      pager(state, total, limit),
    );
  },

  async routes(page, actions) {
    actions.append(h('button', { class: 'primary', onclick: () => routeForm() }, 'New route'));
    const list = await routes(true);
    page.append(
      table(
        [
          { label: 'No.', value: (r) => r.routeNo },
          { label: 'Region', value: (r) => REGION[r.region] ?? r.region },
          { label: 'Name', value: (r) => r.name },
          { label: 'Mode', value: (r) => r.mode },
          { label: 'From → To', value: (r) => `${r.origin} → ${r.destination}` },
          { label: 'Stops', value: (r) => r.stops, num: true },
          { label: 'Vehicles', value: (r) => r.vehicles, num: true },
          { label: 'Status', value: (r) => (r.isActive ? badge('ACTIVE') : badge('INACTIVE', 'bad')) },
          {
            label: '',
            value: (r) =>
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'small', onclick: () => stopsDialog(r) }, 'Stops'),
                h('button', { class: 'small', onclick: () => routeForm(r) }, 'Edit'),
                h('button', {
                  class: `small${r.isActive ? ' danger' : ''}`,
                  onclick: () =>
                    api(`/routes/${r.routeId}`, { method: 'PATCH', body: { isActive: !r.isActive } }).then(() => (toast('Route updated.'), render()), (e) => toast(e.message, true)),
                }, r.isActive ? 'Deactivate' : 'Activate'),
              ),
          },
        ],
        list,
        'No routes yet.',
      ),
    );
  },

  async vehicles(page, actions) {
    actions.append(h('button', { class: 'primary', onclick: () => vehicleForm() }, 'New vehicle'));
    const list = await api('/admin/vehicles');
    page.append(
      table(
        [
          { label: 'ID', value: (v) => v.vehicleId, num: true },
          { label: 'Registration', value: (v) => v.regNo },
          { label: 'Type', value: (v) => v.type },
          { label: 'Capacity', value: (v) => v.capacity, num: true },
          { label: 'Route', value: (v) => v.routeNo },
          { label: 'Status', value: (v) => (v.isActive ? badge('ACTIVE') : badge('INACTIVE', 'bad')) },
          {
            label: '',
            value: (v) =>
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'small', onclick: () => vehicleForm(v) }, 'Edit'),
                h('button', {
                  class: `small${v.isActive ? ' danger' : ''}`,
                  onclick: () =>
                    api(`/admin/vehicles/${v.vehicleId}`, { method: 'PATCH', body: { isActive: !v.isActive } }).then(() => (toast('Vehicle updated.'), render()), (e) => toast(e.message, true)),
                }, v.isActive ? 'Retire' : 'Restore'),
              ),
          },
        ],
        list,
        'No vehicles yet.',
      ),
    );
  },

  async trips(page, actions, state) {
    state.date ??= today();
    actions.append(h('button', { class: 'primary', onclick: () => tripForm() }, 'Schedule trip'));
    const date = h('input', { type: 'date', value: state.date });
    const route = h('select', {}, (await routeOptions('All routes')).map(([v, l]) => h('option', { value: v, selected: String(state.routeId ?? '') === String(v) }, l)));
    const apply = () => { Object.assign(state, { date: date.value || today(), routeId: route.value }); render(); };
    date.addEventListener('change', apply);
    route.addEventListener('change', apply);
    page.append(h('div', { class: 'toolbar' }, date, route));

    const list = await api('/admin/trips', { query: { date: state.date, routeId: state.routeId } });
    const setStatus = (t) =>
      openForm(`Trip #${t.tripId} status`, [
        { name: 'status', label: 'Status', full: true, value: t.status, options: ['SCHEDULED', 'ONGOING', 'DELAYED', 'CANCELLED', 'COMPLETED'].map((s) => [s, s]) },
      ], async (v) => {
        await api(`/trips/${t.tripId}`, { method: 'PATCH', body: { status: v.status } });
        toast('Trip updated.');
        render();
      });
    page.append(
      table(
        [
          { label: 'Trip', value: (t) => `#${t.tripId}` },
          { label: 'Route', value: (t) => t.routeNo },
          { label: 'Vehicle', value: (t) => t.regNo },
          { label: 'Start (local)', value: (t) => fmtClock(t.startTime, t.timeZone) },
          { label: 'End', value: (t) => fmtClock(t.endTime, t.timeZone) },
          { label: 'Tickets', value: (t) => t.tickets, num: true },
          { label: 'Status', value: (t) => badge(t.status) },
          {
            label: '',
            value: (t) =>
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'small', onclick: () => setStatus(t) }, 'Status'),
                h('button', { class: 'small', onclick: () => alertForm(t.tripId) }, 'Alert'),
              ),
          },
        ],
        list,
        'No trips on this day.',
      ),
    );
  },

  async tickets(page, _actions, state) {
    state.page ??= 1;
    const status = h('select', {}, [['', 'All statuses'], ...['PENDING', 'ACTIVE', 'USED', 'EXPIRED', 'CANCELLED'].map((s) => [s, s])].map(([v, l]) => h('option', { value: v, selected: (state.status ?? '') === v }, l)));
    status.addEventListener('change', () => { Object.assign(state, { status: status.value, page: 1 }); render(); });
    page.append(h('div', { class: 'toolbar' }, status));
    const limit = 50;
    const { tickets: list, total } = await api('/admin/tickets', { query: { status: state.status, page: state.page, limit } });
    page.append(
      table(
        [
          { label: 'Ticket', value: (k) => `#${k.ticketId}` },
          { label: 'Passenger', value: (k) => k.passenger },
          { label: 'Route', value: (k) => k.routeNo },
          { label: 'Trip', value: (k) => `#${k.tripId}` },
          { label: 'Fare', value: (k) => fmtMoney(k.fare, k.currency), num: true },
          { label: 'Ticket', value: (k) => badge(k.status) },
          { label: 'Payment', value: (k) => (k.paymentStatus ? badge(k.paymentStatus) : '—') },
          { label: 'Issued', value: (k) => fmtTime(k.issuedAt) },
        ],
        list,
        'No tickets.',
      ),
      pager(state, total, limit),
    );
  },

  async alerts(page, actions) {
    actions.append(h('button', { class: 'primary', onclick: () => alertForm() }, 'Publish alert'));
    const list = await api('/alerts', { query: { limit: 100 } });
    page.append(
      table(
        [
          { label: 'Type', value: (a) => badge(a.type) },
          { label: 'Trip', value: (a) => `#${a.tripId}` },
          { label: 'Message', value: (a) => a.message, wrap: true },
          { label: 'Delay', value: (a) => (a.delayMinutes ? `${a.delayMinutes} min` : '—'), num: true },
          { label: 'Published', value: (a) => fmtTime(a.createdAt) },
        ],
        list,
        'No alerts published yet.',
      ),
    );
  },

  async reports(page, _actions, state) {
    state.type ??= 'ROUTE_PERFORMANCE';
    state.from ??= daysAgo(6);
    state.to ??= today();
    const type = h('select', {}, [['ROUTE_PERFORMANCE', 'Route performance'], ['DELAYS', 'Delays by day'], ['OCCUPANCY', 'Occupancy']].map(([v, l]) => h('option', { value: v, selected: state.type === v }, l)));
    const route = h('select', {}, (await routeOptions('All routes')).map(([v, l]) => h('option', { value: v, selected: String(state.routeId ?? '') === String(v) }, l)));
    const from = h('input', { type: 'date', value: state.from });
    const to = h('input', { type: 'date', value: state.to });
    const run = () => { Object.assign(state, { type: type.value, routeId: route.value, from: from.value, to: to.value }); render(); };
    page.append(h('div', { class: 'toolbar' }, type, route, from, to, h('button', { class: 'primary', onclick: run }, 'Generate')));

    const r = await api('/reports', { query: { type: state.type, routeId: state.routeId, from: state.from, to: state.to } });
    const max = Math.max(1, ...r.rows.map((x) => x.values[r.chartColumn]));
    page.append(
      h('h3', { class: 'section-title' }, `${r.title} · ${r.from} to ${r.to}`),
      table(
        [
          { label: '', value: (x) => x.label },
          ...r.columns.map((c, i) => ({ label: c, value: (x) => x.values[i], num: true })),
          { label: '', value: (x) => h('div', { class: 'bar', style: 'width:180px' }, h('span', { style: `width:${Math.round((x.values[r.chartColumn] / max) * 100)}%` })) },
        ],
        r.rows,
        'No data for this period.',
      ),
    );
  },
};

function pager(state, total, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const go = (p) => { state.page = p; render(); };
  return h(
    'div',
    { class: 'pager' },
    h('span', { class: 'muted' }, `Page ${state.page} of ${pages}`),
    h('button', { class: 'small', disabled: state.page <= 1, onclick: () => go(state.page - 1) }, 'Previous'),
    h('button', { class: 'small', disabled: state.page >= pages, onclick: () => go(state.page + 1) }, 'Next'),
  );
}

// ---------- forms ----------

function newStaffForm() {
  openForm('New staff, officer or admin account', [
    { name: 'role', label: 'Account type', required: true, options: [['STAFF', 'Staff (conductor / inspector)'], ['AUTHORITY', 'Authority officer'], ['ADMIN', 'Admin (email, 12+ character password)']] },
    { name: 'staffType', label: 'Staff type (staff only)', options: [['', '—'], ['CONDUCTOR', 'Conductor'], ['INSPECTOR', 'Inspector']] },
    { name: 'name', label: 'Full name', required: true, full: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Mobile' },
    { name: 'employeeNo', label: 'Employee no. (staff and officers)' },
    { name: 'organisation', label: 'Organisation / department (staff and officers)' },
    { name: 'password', label: 'Temporary password', type: 'password', required: true, full: true },
  ], async (v) => {
    // staff belong to an organisation, officers to a department; admins have neither
    if (v.role === 'AUTHORITY') v.department = v.organisation;
    if (v.role !== 'STAFF') (delete v.staffType, delete v.organisation);
    if (v.role === 'ADMIN') delete v.employeeNo;
    await api('/admin/users', { method: 'POST', body: v });
    toast('Account created.');
    render();
  }, 'Create account');
}

function routeForm(r) {
  openForm(r ? `Edit route ${r.routeNo}` : 'New route', [
    { name: 'routeNo', label: 'Route no.', required: true, value: r?.routeNo },
    ...(r ? [] : [
      { name: 'region', label: 'Region', required: true, options: Object.entries(REGION) },
      { name: 'mode', label: 'Mode', required: true, options: [['BUS', 'Bus'], ['TRAIN', 'Train']] },
    ]),
    { name: 'name', label: 'Name', required: true, full: true, value: r?.name },
    { name: 'origin', label: 'Origin', required: true, value: r?.origin },
    { name: 'destination', label: 'Destination', required: true, value: r?.destination },
  ], async (v) => {
    await api(r ? `/routes/${r.routeId}` : '/routes', { method: r ? 'PATCH' : 'POST', body: v });
    toast(r ? 'Route updated.' : 'Route created.');
    render();
  });
}

async function stopsDialog(r) {
  let detail;
  try {
    detail = await api(`/routes/${r.routeId}`);
  } catch {
    detail = { stops: [] }; // inactive routes are hidden from the public endpoint
  }
  const existing = detail.stops.map((s) => `${s.stopSequence}. ${s.name} (${fmtMoney(s.fareFromOrigin, r.currency)})`).join('\n') || 'No stops yet.';
  const next = (detail.stops.at(-1)?.stopSequence ?? 0) + 1;
  openForm(`Stops · ${r.routeNo}`, [
    { name: 'existing', label: 'Current stops (read only)', type: 'textarea', full: true, value: existing },
    { name: 'name', label: 'New stop name', required: true, full: true },
    { name: 'latitude', label: 'Latitude', type: 'number', step: 'any', min: -90, max: 90, required: true },
    { name: 'longitude', label: 'Longitude', type: 'number', step: 'any', min: -180, max: 180, required: true },
    { name: 'stopSequence', label: 'Sequence', type: 'number', min: 1, required: true, value: next },
    { name: 'fareFromOrigin', label: `Fare from origin (${r.currency ?? 'LKR'})`, type: 'number', min: 0, step: '0.01', required: true },
  ], async ({ existing: _ignored, ...v }) => {
    await api(`/routes/${r.routeId}/stops`, { method: 'POST', body: v });
    toast('Stop added.');
    render();
  }, 'Add stop');
  $('#modal-body textarea').readOnly = true;
  $('#modal-body textarea').required = false;
}

async function vehicleForm(v) {
  const opts = await routeOptions();
  openForm(v ? `Edit vehicle ${v.regNo}` : 'New vehicle', [
    { name: 'regNo', label: 'Registration no.', required: true, value: v?.regNo },
    ...(v ? [] : [{ name: 'type', label: 'Type', required: true, options: [['BUS', 'Bus'], ['TRAIN', 'Train']] }]),
    { name: 'capacity', label: 'Capacity', type: 'number', min: 1, max: 5000, required: true, value: v?.capacity },
    { name: 'routeId', label: 'Route', required: true, full: true, value: v?.routeId, options: opts },
  ], async (x) => {
    x.routeId = Number(x.routeId);
    await api(v ? `/admin/vehicles/${v.vehicleId}` : '/admin/vehicles', { method: v ? 'PATCH' : 'POST', body: x });
    toast(v ? 'Vehicle updated.' : 'Vehicle added.');
    render();
  });
}

async function tripForm() {
  const [opts, vehicles] = await Promise.all([routeOptions(), api('/admin/vehicles')]);
  openForm('Schedule trip', [
    { name: 'routeId', label: 'Route', required: true, full: true, options: opts },
    { name: 'vehicleId', label: 'Vehicle (must be on that route)', required: true, full: true, options: vehicles.filter((x) => x.isActive).map((x) => [x.vehicleId, `${x.regNo} · route ${x.routeNo}`]) },
    { name: 'startTime', label: 'Departure', type: 'datetime-local', required: true },
    { name: 'endTime', label: 'Arrival (optional)', type: 'datetime-local' },
  ], async (v) => {
    await api('/trips', { method: 'POST', body: { ...v, routeId: Number(v.routeId), vehicleId: Number(v.vehicleId) } });
    toast('Trip scheduled.');
    render();
  }, 'Schedule');
}

function alertForm(tripId) {
  openForm('Publish alert', [
    { name: 'tripId', label: 'Trip ID', type: 'number', min: 1, required: true, value: tripId },
    { name: 'type', label: 'Type', required: true, options: [['DELAY', 'Delay'], ['CANCELLATION', 'Cancellation'], ['ROUTE_CHANGE', 'Route change']] },
    { name: 'delayMinutes', label: 'Delay (minutes, delays only)', type: 'number', min: 1, max: 600 },
    { name: 'message', label: 'Message to passengers', type: 'textarea', required: true, full: true, max: 255 },
  ], async (v) => {
    if (v.type !== 'DELAY') delete v.delayMinutes;
    await api('/alerts', { method: 'POST', body: v });
    toast('Alert sent to ticket holders.');
    render();
  }, 'Publish');
}

// ---------- shell ----------

const TITLES = { overview: 'Overview', users: 'Users', routes: 'Routes', vehicles: 'Vehicles', trips: 'Trips', tickets: 'Tickets', alerts: 'Alerts', reports: 'Reports' };
// accounts are managed by admins only
const visiblePages = () => Object.keys(TITLES).filter((n) => n !== 'users' || isAdmin());
const pageState = {};
let renderSeq = 0;

async function render() {
  const name = visiblePages().includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  const seq = ++renderSeq;
  document.querySelectorAll('#nav a').forEach((a) => {
    const current = a.getAttribute('href') === `#${name}`;
    a.classList.toggle('active', current);
    if (current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // on a phone the menu is one scrolling row: keep the current page in view
  document.querySelector('#nav a.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#page-title').textContent = TITLES[name];
  const page = h('div');
  const actions = h('div', { class: 'actions' });
  try {
    await pages[name](page, actions, (pageState[name] ??= {}));
  } catch (e) {
    page.replaceChildren(h('div', { class: 'card empty error' }, e.message));
  }
  if (seq !== renderSeq) return; // a newer render started meanwhile
  $('#page').replaceChildren(page, pageNav(name));
  $('#page-actions').replaceChildren(...actions.childNodes);
}

// Previous / Next buttons at the foot of every page, in menu order
function pageNav(name) {
  const names = visiblePages();
  const i = names.indexOf(name);
  const link = (target, label, cls) => (target
    ? h('a', { href: `#${target}`, class: `page-nav-btn ${cls}` }, label)
    : h('span')); // keeps the other button on its side
  return h('div', { class: 'page-nav', role: 'navigation', 'aria-label': 'Page navigation' },
    link(names[i - 1], `← ${TITLES[names[i - 1]]}`, 'prev'),
    link(names[i + 1], `${TITLES[names[i + 1]]} →`, 'next'));
}

function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  $('#login-form [name=identifier]').focus();
}

function showShell() {
  $('#login').hidden = true;
  $('#shell').hidden = false;
  $('#me-name').textContent = session.user?.name ?? '';
  document.querySelectorAll('#nav a').forEach((a) => (a.hidden = !visiblePages().includes(a.getAttribute('href').slice(1))));
  render();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.hidden = true;
  form.querySelector('button').disabled = true;
  try {
    const identifier = form.identifier.value;
    const password = form.password.value;
    // officers use the app sign-in; admins are refused there with the same error, so try the admin sign-in next
    const data = await api('/auth/login', { method: 'POST', body: { identifier, password } }).catch((ex) => {
      if (!identifier.includes('@')) throw ex;
      return api('/admin/auth/login', { method: 'POST', body: { email: identifier, password } }).catch(() => { throw ex; });
    });
    if (!PANEL_ROLES.includes(data.user.role)) throw new Error('Only admins and authority officers can use the admin panel.');
    saveSession({ access: data.accessToken, refresh: data.refreshToken, user: data.user });
    form.reset();
    showShell();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    form.querySelector('button').disabled = false;
  }
});

function showForgot(show) {
  const form = $('#forgot-form');
  form.reset();
  $('#forgot-step2').hidden = true;
  $('#forgot-error').hidden = true;
  form.querySelector('button[type=submit]').textContent = 'Send code';
  $('#login-form').hidden = show;
  form.hidden = !show;
  if (show) form.identifier.value = $('#login-form').identifier.value;
  (show ? form : $('#login-form')).identifier.focus();
}

$('#forgot-open').addEventListener('click', () => showForgot(true));
$('#forgot-back').addEventListener('click', () => showForgot(false));

// step 1 sends the code; step 2 sets the new password with it
$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#forgot-error');
  const submit = form.querySelector('button[type=submit]');
  const step2 = !$('#forgot-step2').hidden;
  err.hidden = true;
  submit.disabled = true;
  try {
    if (!step2) {
      const data = await api('/auth/forgot-password', { method: 'POST', body: { identifier: form.identifier.value } });
      $('#forgot-hint').textContent = `${data.message} Enter it below with your new password.`;
      $('#forgot-step2').hidden = false;
      form.code.required = form.password.required = true;
      submit.textContent = 'Reset password';
      form.code.focus();
      return;
    }
    const data = await api('/auth/reset-password', {
      method: 'POST',
      body: { identifier: form.identifier.value, code: form.code.value, password: form.password.value },
    });
    if (!PANEL_ROLES.includes(data.user.role)) throw new Error('Password changed. Only admins and authority officers can use the admin panel.');
    saveSession({ access: data.accessToken, refresh: data.refreshToken, user: data.user });
    showForgot(false);
    showShell();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$('#logout').addEventListener('click', logout);
window.addEventListener('hashchange', () => session.access && render());

if (session.access && PANEL_ROLES.includes(session.user?.role)) showShell();
else showLogin();
