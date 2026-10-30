'use strict';

const auth = require('./handlers/auth');
const account = require('./handlers/account');
const properties = require('./handlers/properties');
const tenancies = require('./handlers/tenancies');
const documents = require('./handlers/documents');
const { HttpError } = require('./errors');
const files = require('./files');

const DEFAULT_MAX_BYTES = 64 * 1024;
const UPLOAD_MAX_BYTES = Math.ceil((files.MAX_DOCUMENT_BYTES * 4) / 3) + 64 * 1024;

function route(method, template, handler, { auth: requiresAuth = true, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const names = [];
  // Escape the template first so dots (as in export.csv) match literally.
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/:(\w+)/g, (_match, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), names, handler, requiresAuth, maxBytes };
}

const routes = [
  route('POST', '/api/auth/register', auth.register, { auth: false }),
  route('POST', '/api/auth/login', auth.login, { auth: false }),
  route('POST', '/api/auth/logout', auth.logout, { auth: false }),
  route('POST', '/api/auth/forgot', auth.forgotPassword, { auth: false }),
  route('POST', '/api/auth/reset', auth.resetPassword, { auth: false }),

  route('GET', '/api/me', account.me),
  route('PUT', '/api/me/preferences', account.setPreferences),
  route('DELETE', '/api/me', account.deleteAccount),
  route('GET', '/api/dashboard', account.dashboard),
  route('GET', '/api/export', account.exportAccount),

  route('POST', '/api/properties', properties.createProperty),
  route('GET', '/api/properties/:id', properties.getProperty),
  route('PUT', '/api/properties/:id', properties.updateProperty),
  route('DELETE', '/api/properties/:id', properties.deleteProperty),
  route('GET', '/api/properties/:id/export.csv', properties.exportPropertyCsv),

  route('PUT', '/api/properties/:id/items/:type', properties.saveItem),
  route('DELETE', '/api/properties/:id/items/:type', properties.deleteItem),
  route('POST', '/api/properties/:id/items/:type/documents', documents.uploadDocument, { maxBytes: UPLOAD_MAX_BYTES }),

  route('POST', '/api/properties/:id/tenancies', tenancies.createTenancy),
  route('PUT', '/api/properties/:id/tenancies/:tenancyId', tenancies.updateTenancy),
  route('DELETE', '/api/properties/:id/tenancies/:tenancyId', tenancies.deleteTenancy),

  route('GET', '/api/documents/:id', documents.downloadDocument),
  route('DELETE', '/api/documents/:id', documents.deleteDocument),
];

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const candidate of routes) {
    const match = candidate.pattern.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (candidate.method !== method) continue;
    const params = Object.fromEntries(candidate.names.map((name, index) => [name, match[index + 1]]));
    return { route: candidate, params };
  }
  throw pathMatched ? new HttpError(405, 'Method not allowed.') : new HttpError(404, 'Not found.');
}

module.exports = { matchRoute };
