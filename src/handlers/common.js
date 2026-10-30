'use strict';

const { HttpError } = require('../errors');

// Counts one attempt against a limiter and throws 429 when the limit is reached.
function enforce(limiter, key) {
  const result = limiter.hit(key);
  if (!result.allowed) {
    throw new HttpError(429, 'Too many attempts. Please wait a while and try again.', {
      'Retry-After': String(result.retryAfterSeconds),
    });
  }
}

// Every query for a property goes through here, so a user can never reach
// another user's data by guessing an id.
function ownedProperty(db, userId, id, store) {
  const row = store.getPropertyRow(db, userId, id);
  if (!row) throw new HttpError(404, 'Property not found.');
  return store.toProperty(row);
}

module.exports = { enforce, ownedProperty };
