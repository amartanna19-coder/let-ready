'use strict';

const app = document.getElementById('app');
const account = document.getElementById('account');
const statusBox = document.getElementById('status');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

const STATUS_LABELS = {
  complete: 'Complete',
  valid: 'Valid',
  due_soon: 'Due soon',
  expired: 'Expired',
  missing: 'Missing',
  late: 'Completed late',
};
const STATUS_TONES = {
  complete: 'ok',
  valid: 'ok',
  due_soon: 'warn',
  expired: 'danger',
  missing: 'danger',
  late: 'danger',
};

const state = { user: null, authMode: 'login' };

async function api(method, url, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body || {});
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Could not reach Let Ready. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

// Builds DOM nodes without innerHTML, so user-entered text can never run as markup.
function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'value') node.value = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function field(text, control, extraClass = '') {
  return h('label', { class: `field ${extraClass}`.trim() }, h('span', {}, text), control);
}

function mount(...children) {
  app.replaceChildren(...children.flat());
}

function announce(message) {
  statusBox.textContent = '';
  // Re-setting the text after a tick makes screen readers announce repeated messages.
  setTimeout(() => {
    statusBox.textContent = message;
  }, 50);
}

function go(hash) {
  if (location.hash === hash) render({ moveFocus: true });
  else location.hash = hash;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatPence(pence) {
  if (pence === null || pence === undefined) return '';
  return `£${(pence / 100).toFixed(2)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

function statusText(item) {
  if (item.status === 'expired') return `Expired ${formatDate(item.expires_on || item.deadline)}`;
  if (item.status === 'late') return STATUS_LABELS.late;
  if (item.status === 'due_soon' && item.days_left !== null && item.days_left !== undefined) {
    return item.days_left === 0 ? 'Due soon · expires today' : `Due soon · ${item.days_left} days left`;
  }
  if (item.status === 'valid' && item.days_left !== null && item.days_left !== undefined) {
    return `Valid · ${item.days_left} days left`;
  }
  return STATUS_LABELS[item.status];
}

function badge(item) {
  return h('span', { class: `badge ${STATUS_TONES[item.status]}` }, statusText(item));
}

function progress(score, label) {
  const fill = h('span', { class: 'progress-fill' });
  fill.style.width = `${score ?? 0}%`;
  return h(
    'div',
    { class: 'progress', role: 'img', 'aria-label': score === null || score === undefined ? 'No checks yet' : `${label ?? ''} ${score}% ready`.trim() },
    fill,
  );
}

function errorBox() {
  return h('p', { class: 'form-error', role: 'alert' });
}

function renderAccount() {
  if (!state.user) {
    account.replaceChildren();
    return;
  }
  account.replaceChildren(
    h('a', { href: '#/settings' }, 'Settings'),
    h('span', { class: 'muted account-email' }, state.user.email),
    h('button', { class: 'button ghost', type: 'button', onclick: logout }, 'Log out'),
  );
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout');
  } catch {
    // The session may already have expired; clearing it locally is enough.
  }
  state.user = null;
  state.authMode = 'login';
  announce('You have logged out.');
  go('#/');
}

function currentRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const property = pathPart.match(/^\/property\/(\d+)$/);
  if (property) return { name: 'property', id: property[1] };
  if (pathPart === '/forgot') return { name: 'forgot' };
  if (pathPart === '/reset') return { name: 'reset', token: params.get('token') || '' };
  if (pathPart === '/settings') return { name: 'settings' };
  return { name: 'dashboard' };
}

function focusHeading() {
  const heading = app.querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  }
}

// moveFocus is set only when the page changes. Re-rendering after a save keeps
// focus where the user left it, so keyboard users are not sent back to the top.
async function render({ moveFocus = false } = {}) {
  renderAccount();
  const route = currentRoute();
  // Controls are rebuilt on every render, so remember the focused one by its label.
  const focusedLabel = document.activeElement && document.activeElement.getAttribute('aria-label');
  try {
    if (route.name === 'forgot') renderForgot();
    else if (route.name === 'reset') renderReset(route.token);
    else if (!state.user) renderAuth();
    else if (route.name === 'property') await renderProperty(route.id);
    else if (route.name === 'settings') renderSettings();
    else await renderDashboard();
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      renderAuth();
    } else {
      mount(h('p', { class: 'form-error', role: 'alert' }, error.message));
    }
  }
  if (moveFocus) {
    focusHeading();
  } else if (focusedLabel) {
    const control = [...app.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === focusedLabel);
    if (control) control.focus();
  }
}

// ---- Authentication -------------------------------------------------------

function renderAuth() {
  const isRegister = state.authMode === 'register';
  const error = errorBox();
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: isRegister ? 'email' : 'username' });
  const password = h('input', {
    type: 'password',
    name: 'password',
    required: true,
    minlength: isRegister ? 8 : null,
    autocomplete: isRegister ? 'new-password' : 'current-password',
  });
  const submit = h('button', { class: 'button primary', type: 'submit' }, isRegister ? 'Create account' : 'Log in');

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const path = isRegister ? '/api/auth/register' : '/api/auth/login';
          const data = await api('POST', path, { email: email.value, password: password.value });
          state.user = data.user;
          announce(isRegister ? 'Account created.' : 'Logged in.');
          go('#/');
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    field('Email', email),
    field(isRegister ? 'Password (at least 8 characters)' : 'Password', password),
    error,
    submit,
  );

  mount(
    h(
      'section',
      { class: 'card narrow' },
      h('h1', {}, isRegister ? 'Create your account' : 'Log in to Let Ready'),
      h(
        'p',
        { class: 'muted' },
        'Keep track of gas, electrical, energy, licence and deposit deadlines for each of your London properties in one place.',
      ),
      form,
      !isRegister ? h('p', { class: 'switch' }, h('a', { href: '#/forgot' }, 'Forgot your password?')) : null,
      h(
        'p',
        { class: 'switch' },
        isRegister ? 'Already have an account? ' : 'New here? ',
        h(
          'button',
          {
            class: 'link',
            type: 'button',
            onclick: () => {
              state.authMode = isRegister ? 'login' : 'register';
              render();
            },
          },
          isRegister ? 'Log in' : 'Create an account',
        ),
      ),
    ),
  );
}

function renderForgot() {
  const error = errorBox();
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' });
  const submit = h('button', { class: 'button primary', type: 'submit' }, 'Send reset link');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const data = await api('POST', '/api/auth/forgot', { email: email.value });
          mount(
            h(
              'section',
              { class: 'card narrow' },
              h('h1', {}, 'Check your email'),
              h('p', {}, data.message),
              h('p', {}, h('a', { href: '#/' }, 'Back to log in')),
            ),
          );
          focusHeading();
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    field('Email', email),
    error,
    submit,
  );
  mount(
    h(
      'section',
      { class: 'card narrow' },
      h('h1', {}, 'Reset your password'),
      h('p', { class: 'muted' }, 'Enter the email for your account and we will send you a link to choose a new password.'),
      form,
      h('p', { class: 'switch' }, h('a', { href: '#/' }, 'Back to log in')),
    ),
  );
}

function renderReset(token) {
  const error = errorBox();
  const password = h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', name: 'confirm', required: true, minlength: 8, autocomplete: 'new-password' });
  const submit = h('button', { class: 'button primary', type: 'submit' }, 'Set new password');

  if (!token) {
    mount(
      h(
        'section',
        { class: 'card narrow' },
        h('h1', {}, 'This link is incomplete'),
        h('p', {}, 'Open the link from your reset email, or request a new one.'),
        h('p', {}, h('a', { href: '#/forgot' }, 'Request a new reset link')),
      ),
    );
    return;
  }

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        if (password.value !== confirm.value) {
          error.textContent = 'The two passwords do not match.';
          return;
        }
        submit.disabled = true;
        try {
          await api('POST', '/api/auth/reset', { token, password: password.value });
          state.user = null;
          mount(
            h(
              'section',
              { class: 'card narrow' },
              h('h1', {}, 'Password updated'),
              h('p', {}, 'You can now log in with your new password.'),
              h('p', {}, h('a', { href: '#/' }, 'Log in')),
            ),
          );
          focusHeading();
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    field('New password (at least 8 characters)', password),
    field('Confirm new password', confirm),
    error,
    submit,
  );
  mount(h('section', { class: 'card narrow' }, h('h1', {}, 'Choose a new password'), form));
}

// ---- Dashboard ------------------------------------------------------------

async function renderDashboard() {
  const data = await api('GET', '/api/dashboard');

  const attentionList = data.attention.length
    ? h(
        'ul',
        { class: 'list' },
        data.attention.map((item) =>
          h(
            'li',
            { class: 'row' },
            h(
              'div',
              {},
              h('a', { href: `#/property/${item.property_id}` }, item.address),
              h('div', { class: 'muted small' }, item.label),
            ),
            badge(item),
          ),
        ),
      )
    : h(
        'p',
        { class: 'muted' },
        data.properties.length ? 'Nothing needs attention right now.' : 'Add a property below to start tracking compliance.',
      );

  const propertyCards = data.properties.map((property) =>
    h(
      'li',
      { class: 'card' },
      h('a', { class: 'card-link', href: `#/property/${property.id}` }, property.address),
      h('p', { class: 'muted small' }, [property.postcode, property.borough].filter(Boolean).join(' · ')),
      progress(property.score, property.address),
      h(
        'p',
        { class: 'muted small' },
        property.attention_count
          ? `${property.attention_count} ${plural(property.attention_count, 'item', 'items')} to action`
          : 'All clear',
      ),
    ),
  );

  const summaryText =
    data.summary.total === 0
      ? 'No properties yet.'
      : `${data.summary.compliant} of ${data.summary.total} checks passing across ${data.properties.length} ${plural(data.properties.length, 'property', 'properties')}`;

  mount(
    h('div', { class: 'page-head' }, h('h1', {}, 'Your properties')),
    h(
      'section',
      { class: 'card summary' },
      h(
        'div',
        {},
        h('p', { class: 'muted' }, 'Portfolio readiness'),
        h('p', { class: 'big' }, data.summary.score === null ? '—' : `${data.summary.score}%`),
      ),
      h('div', {}, progress(data.summary.score, 'Portfolio'), h('p', { class: 'muted' }, summaryText)),
    ),
    h('section', {}, h('h2', {}, 'Needs attention'), h('div', { class: 'card' }, attentionList)),
    data.properties.length ? h('section', {}, h('h2', {}, 'Properties'), h('ul', { class: 'grid' }, propertyCards)) : null,
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Add a property'),
      propertyForm(null, async (input) => {
        const created = await api('POST', '/api/properties', input);
        announce('Property added.');
        go(`#/property/${created.id}`);
      }),
    ),
  );
}

function propertyForm(property, onSave) {
  const current = property || { address: '', postcode: '', borough: '', has_gas: true, is_hmo: false };
  const address = h('input', { name: 'address', required: true, maxlength: 200, value: current.address });
  const postcode = h('input', {
    name: 'postcode',
    required: true,
    maxlength: 10,
    autocomplete: 'postal-code',
    value: current.postcode,
  });
  const borough = h('input', { name: 'borough', maxlength: 60, value: current.borough || '' });
  const hasGas = h('input', { type: 'checkbox', name: 'has_gas' });
  const isHmo = h('input', { type: 'checkbox', name: 'is_hmo' });
  hasGas.checked = current.has_gas;
  isHmo.checked = current.is_hmo;

  const error = errorBox();
  const submit = h('button', { class: 'button primary', type: 'submit' }, property ? 'Save details' : 'Add property');

  return h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          await onSave({
            address: address.value,
            postcode: postcode.value,
            borough: borough.value,
            has_gas: hasGas.checked,
            is_hmo: isHmo.checked,
          });
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'grid-2' }, field('Address', address), field('Postcode', postcode)),
    field('Borough', borough),
    h('label', { class: 'check' }, hasGas, 'Has gas appliances or a gas supply'),
    h('label', { class: 'check' }, isHmo, 'House in multiple occupation (HMO)'),
    error,
    h('div', { class: 'actions' }, submit),
  );
}

// ---- Property page --------------------------------------------------------

async function renderProperty(id) {
  const data = await api('GET', `/api/properties/${id}`);
  const { property, items, not_applicable: notApplicable, summary, tenancies } = data;

  const remove = h(
    'button',
    {
      class: 'button danger',
      type: 'button',
      onclick: async () => {
        if (!window.confirm(`Delete ${property.address} and all its records and documents? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/properties/${id}`);
          announce('Property deleted.');
          go('#/');
        } catch (error) {
          window.alert(error.message);
        }
      },
    },
    'Delete property',
  );

  mount(
    h('p', {}, h('a', { href: '#/' }, '← All properties')),
    h(
      'header',
      { class: 'page-head' },
      h('h1', {}, property.address),
      h('p', { class: 'muted' }, [property.postcode, property.borough].filter(Boolean).join(' · ')),
      progress(summary.score, property.address),
      h('p', { class: 'muted' }, `${summary.compliant} of ${summary.total} checklist items passing`),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'button', href: `/api/properties/${id}/export.csv` }, 'Download checklist (CSV)'),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Property details'),
      propertyForm(property, async (input) => {
        await api('PUT', `/api/properties/${id}`, input);
        announce('Property details saved.');
        await render();
      }),
      h('div', { class: 'actions' }, remove),
    ),
    h('section', {}, h('h2', {}, 'Compliance checklist'), items.map((item) => itemCard(id, item))),
    h('section', {}, h('h2', {}, 'Tenancies and deposits'), tenancySection(id, tenancies)),
    notApplicable.length
      ? h(
          'section',
          { class: 'card not-applicable' },
          h('h2', {}, 'Not applicable to this property'),
          h('ul', {}, notApplicable.map((entry) => h('li', {}, entry.label))),
        )
      : null,
  );
}

function dueText(item) {
  const record = item.record || {};
  if (item.one_off) {
    return record.completed_on ? `Recorded ${formatDate(record.completed_on)}` : 'Not recorded yet';
  }
  return item.expires_on ? `Expires ${formatDate(item.expires_on)}` : 'Not recorded yet';
}

function documentList(propertyId, documents) {
  if (!documents.length) return h('p', { class: 'muted small' }, 'No certificate uploaded yet.');
  return h(
    'ul',
    { class: 'doc-list' },
    documents.map((doc) => {
      const remove = h(
        'button',
        {
          class: 'button ghost',
          type: 'button',
          'aria-label': `Remove ${doc.filename}`,
          onclick: async () => {
            if (!window.confirm(`Remove ${doc.filename}?`)) return;
            try {
              await api('DELETE', `/api/documents/${doc.id}`);
              announce('File removed.');
              await render();
            } catch (error) {
              window.alert(error.message);
            }
          },
        },
        'Remove',
      );
      return h(
        'li',
        { class: 'row' },
        h('a', { href: `/api/documents/${doc.id}` }, doc.filename),
        h('span', { class: 'muted small' }, `${formatBytes(doc.size_bytes)} · uploaded ${formatDate(doc.uploaded_at.slice(0, 10))}`),
        remove,
      );
    }),
  );
}

function uploadControl(propertyId, item) {
  const error = errorBox();
  const input = h('input', {
    type: 'file',
    accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png',
    'aria-describedby': `upload-help-${item.type}`,
  });
  const help = h('p', { class: 'muted small', id: `upload-help-${item.type}` }, 'PDF, JPEG or PNG, up to 5 MB.');
  const button = h(
    'button',
    {
      class: 'button',
      type: 'button',
      onclick: async () => {
        error.textContent = '';
        const file = input.files[0];
        if (!file) {
          error.textContent = 'Choose a file first.';
          return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          error.textContent = 'Files must be 5 MB or smaller.';
          return;
        }
        if (!UPLOAD_TYPES.includes(file.type)) {
          error.textContent = 'Upload a PDF, JPEG or PNG file.';
          return;
        }
        button.disabled = true;
        try {
          const data = await readFileAsBase64(file);
          await api('POST', `/api/properties/${propertyId}/items/${item.type}/documents`, {
            filename: file.name,
            content_type: file.type,
            data,
          });
          announce(`Uploaded ${file.name}.`);
          await render();
        } catch (err) {
          error.textContent = err.message;
          button.disabled = false;
        }
      },
    },
    'Upload certificate',
  );
  return h(
    'div',
    { class: 'upload' },
    h('label', { class: 'field' }, h('span', {}, 'Certificate file'), input),
    help,
    h('div', { class: 'actions' }, button),
    error,
  );
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('We could not read that file. Try another.'));
    reader.readAsDataURL(file);
  });
}

function itemCard(propertyId, item) {
  const record = item.record || {};
  const error = errorBox();

  const completed = h('input', { type: 'date', name: 'completed_on', value: record.completed_on || '' });
  const reference = h('input', { name: 'reference', maxlength: 100, value: record.reference || '' });
  const notes = h('textarea', { name: 'notes', rows: 2, maxlength: 1000, value: record.notes || '' });
  const expires = item.one_off ? null : h('input', { type: 'date', name: 'expires_on', value: record.expires_on || '' });

  const fields = [field(item.expiry_required ? 'Date completed (optional)' : 'Date completed', completed)];
  if (expires) {
    fields.push(
      field(
        item.expiry_required ? 'Licence expiry date' : 'Expiry date (only if it differs from the default)',
        expires,
      ),
    );
  }
  fields.push(field('Reference (optional)', reference));
  fields.push(field('Notes (optional)', notes, 'wide'));

  const save = h(
    'button',
    {
      class: 'button primary',
      type: 'button',
      'aria-label': `Save ${item.label}`,
      onclick: async () => {
        error.textContent = '';
        try {
          await api('PUT', `/api/properties/${propertyId}/items/${item.type}`, {
            completed_on: completed.value,
            expires_on: expires ? expires.value : '',
            reference: reference.value,
            notes: notes.value,
          });
          announce(`Saved ${item.label}.`);
          await render();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    'Save',
  );

  const clear =
    record.completed_on || record.expires_on
      ? h(
          'button',
          {
            class: 'button',
            type: 'button',
            'aria-label': `Clear ${item.label}`,
            onclick: async () => {
              error.textContent = '';
              try {
                await api('DELETE', `/api/properties/${propertyId}/items/${item.type}`);
                announce(`Cleared ${item.label}.`);
                await render();
              } catch (err) {
                error.textContent = err.message;
              }
            },
          },
          'Clear',
        )
      : null;

  return h(
    'article',
    { class: 'card item' },
    h('div', { class: 'item-head' }, h('h3', {}, item.label), badge(item)),
    h('p', { class: 'muted small guidance' }, item.guidance),
    h('p', { class: 'small due' }, dueText(item)),
    h('div', { class: 'form-grid' }, fields),
    error,
    h('div', { class: 'actions' }, save, clear),
    h('details', { class: 'files' }, h('summary', {}, `Certificates (${item.documents.length})`), documentList(propertyId, item.documents), uploadControl(propertyId, item)),
  );
}

// ---- Tenancies ------------------------------------------------------------

function tenancyFormFields(tenancy) {
  const current = tenancy || {};
  const inputs = {
    tenant_name: h('input', { name: 'tenant_name', maxlength: 120, required: true, value: current.tenant_name || '' }),
    start_date: h('input', { type: 'date', name: 'start_date', required: true, value: current.start_date || '' }),
    deposit_amount: h('input', {
      name: 'deposit_amount',
      inputmode: 'decimal',
      placeholder: 'For example 1200.00',
      value: current.deposit_amount_pence === null || current.deposit_amount_pence === undefined ? '' : (current.deposit_amount_pence / 100).toFixed(2),
    }),
    deposit_received_on: h('input', { type: 'date', name: 'deposit_received_on', value: current.deposit_received_on || '' }),
    deposit_protected_on: h('input', { type: 'date', name: 'deposit_protected_on', value: current.deposit_protected_on || '' }),
    prescribed_info_given_on: h('input', {
      type: 'date',
      name: 'prescribed_info_given_on',
      value: current.prescribed_info_given_on || '',
    }),
    notes: h('textarea', { name: 'notes', rows: 2, maxlength: 1000, value: current.notes || '' }),
  };
  const nodes = [
    h('div', { class: 'grid-2' }, field('Tenant name', inputs.tenant_name), field('Tenancy start date', inputs.start_date)),
    h(
      'div',
      { class: 'grid-2' },
      field('Deposit amount (£)', inputs.deposit_amount),
      field('Date deposit received', inputs.deposit_received_on),
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('Date deposit protected', inputs.deposit_protected_on),
      field('Date prescribed information given', inputs.prescribed_info_given_on),
    ),
    field('Notes (optional)', inputs.notes),
  ];
  return { inputs, nodes };
}

function readTenancyInputs(inputs) {
  const amount = inputs.deposit_amount.value.trim();
  let deposit = '';
  if (amount) {
    const pounds = Number(amount);
    if (!Number.isFinite(pounds) || pounds < 0) throw new Error('Deposit amount must be a number, such as 1200.00.');
    deposit = Math.round(pounds * 100);
  }
  return {
    tenant_name: inputs.tenant_name.value,
    start_date: inputs.start_date.value,
    deposit_amount_pence: deposit === '' ? null : deposit,
    deposit_received_on: inputs.deposit_received_on.value,
    deposit_protected_on: inputs.deposit_protected_on.value,
    prescribed_info_given_on: inputs.prescribed_info_given_on.value,
    notes: inputs.notes.value,
  };
}

function tenancyChecksList(tenancy) {
  if (!tenancy.checks.length) {
    return h('p', { class: 'muted small' }, 'Enter the date the deposit was received to see its 30-day deadlines.');
  }
  return h(
    'ul',
    { class: 'checks' },
    tenancy.checks.map((check) =>
      h(
        'li',
        { class: 'row' },
        h(
          'div',
          {},
          h('span', {}, check.label),
          h(
            'div',
            { class: 'muted small' },
            check.done_on ? `Done ${formatDate(check.done_on)}` : `Deadline ${formatDate(check.deadline)}`,
          ),
        ),
        badge(check),
      ),
    ),
  );
}

function tenancySection(propertyId, tenancies) {
  const cards = tenancies.map((tenancy) => {
    const error = errorBox();
    const form = tenancyFormFields(tenancy);
    const save = h(
      'button',
      {
        class: 'button primary',
        type: 'button',
        'aria-label': `Save tenancy for ${tenancy.tenant_name}`,
        onclick: async () => {
          error.textContent = '';
          try {
            await api('PUT', `/api/properties/${propertyId}/tenancies/${tenancy.id}`, readTenancyInputs(form.inputs));
            announce('Tenancy saved.');
            await render();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      'Save tenancy',
    );
    const remove = h(
      'button',
      {
        class: 'button danger',
        type: 'button',
        'aria-label': `Delete tenancy for ${tenancy.tenant_name}`,
        onclick: async () => {
          if (!window.confirm(`Delete the tenancy for ${tenancy.tenant_name}?`)) return;
          try {
            await api('DELETE', `/api/properties/${propertyId}/tenancies/${tenancy.id}`);
            announce('Tenancy deleted.');
            await render();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      'Delete',
    );
    return h(
      'article',
      { class: 'card item' },
      h('h3', {}, tenancy.tenant_name, ` · from ${formatDate(tenancy.start_date)}`),
      tenancy.deposit_amount_pence !== null ? h('p', { class: 'small' }, `Deposit ${formatPence(tenancy.deposit_amount_pence)}`) : null,
      tenancyChecksList(tenancy),
      h(
        'details',
        { class: 'files' },
        h('summary', {}, 'Edit tenancy'),
        h('div', { class: 'stack' }, form.nodes),
        error,
        h('div', { class: 'actions' }, save, remove),
      ),
    );
  });

  const addError = errorBox();
  const add = tenancyFormFields(null);
  const addButton = h(
    'button',
    {
      class: 'button primary',
      type: 'button',
      onclick: async () => {
        addError.textContent = '';
        try {
          await api('POST', `/api/properties/${propertyId}/tenancies`, readTenancyInputs(add.inputs));
          announce('Tenancy added.');
          await render();
        } catch (err) {
          addError.textContent = err.message;
        }
      },
    },
    'Add tenancy',
  );

  return [
    cards.length ? cards : h('p', { class: 'muted' }, 'No tenancies recorded yet.'),
    h(
      'details',
      { class: 'card' },
      h('summary', {}, 'Add a tenancy'),
      h('div', { class: 'stack' }, add.nodes),
      addError,
      h('div', { class: 'actions' }, addButton),
    ),
  ].flat();
}

// ---- Settings -------------------------------------------------------------

function renderSettings() {
  const remindersMessage = h('p', { class: 'muted small', role: 'status' });
  const remindersInput = h('input', {
    type: 'checkbox',
    name: 'email_reminders',
    onchange: async () => {
      remindersMessage.textContent = '';
      try {
        const data = await api('PUT', '/api/me/preferences', { email_reminders: remindersInput.checked });
        state.user.email_reminders = data.email_reminders;
        remindersMessage.textContent = data.email_reminders ? 'Email reminders are on.' : 'Email reminders are off.';
      } catch (err) {
        remindersInput.checked = !remindersInput.checked;
        remindersMessage.textContent = err.message;
      }
    },
  });
  remindersInput.checked = state.user.email_reminders;

  const deleteError = errorBox();
  const deletePassword = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const deleteButton = h(
    'button',
    {
      class: 'button danger',
      type: 'button',
      onclick: async () => {
        deleteError.textContent = '';
        if (!window.confirm('Delete your account and every property, record and document in it? This cannot be undone.')) return;
        try {
          await api('DELETE', '/api/me', { password: deletePassword.value });
          state.user = null;
          state.authMode = 'login';
          announce('Your account has been deleted.');
          go('#/');
        } catch (err) {
          deleteError.textContent = err.message;
        }
      },
    },
    'Delete my account',
  );

  mount(
    h('p', {}, h('a', { href: '#/' }, '← All properties')),
    h('h1', {}, 'Settings'),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Email reminders'),
      h(
        'p',
        { class: 'muted' },
        'We email you 30 days and 7 days before a certificate expires or a deposit deadline, and when one has passed.',
      ),
      h('label', { class: 'check' }, remindersInput, 'Send me email reminders'),
      remindersMessage,
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Your data'),
      h('p', { class: 'muted' }, 'Download everything in your account as a JSON file. Documents are listed by name, not included.'),
      h('a', { class: 'button', href: '/api/export' }, 'Download my data (JSON)'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Delete account'),
      h('p', { class: 'muted' }, 'This removes your account, properties, tenancies and uploaded documents permanently.'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: (event) => event.preventDefault(),
        },
        field('Confirm with your password', deletePassword),
        deleteError,
        h('div', { class: 'actions' }, deleteButton),
      ),
    ),
  );
}

async function start() {
  try {
    const data = await api('GET', '/api/me');
    state.user = data.user;
  } catch {
    state.user = null;
  }
  window.addEventListener('hashchange', () => render({ moveFocus: true }));
  await render({ moveFocus: true });
}

start();
