'use strict';

const compliance = require('./compliance');
const { HttpError } = require('./errors');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_DEPOSIT_PENCE = 10000000;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function cleanText(value, { field, max, required = false, singleLine = true }) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  if (text.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  if (singleLine ? CONTROL_CHARS.test(text) : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new HttpError(400, `${field} contains characters that are not allowed.`);
  }
  return text;
}

function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email) || CONTROL_CHARS.test(email)) {
    throw new HttpError(400, 'Please enter a valid email address.');
  }
  return email;
}

function cleanPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

function cleanBoolean(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be yes or no.`);
  return value;
}

function cleanPostcode(value) {
  const compact = typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
  if (!POSTCODE_PATTERN.test(compact)) {
    throw new HttpError(400, 'Please enter a valid UK postcode, such as E1 6AN.');
  }
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function cleanDate(value, field, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  if (!compliance.isValidDate(text)) throw new HttpError(400, `${field} must be a real date.`);
  const year = Number(text.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) throw new HttpError(400, `${field} must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  return text;
}

function cleanPence(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEPOSIT_PENCE) {
    throw new HttpError(400, `${field} must be a whole number of pence between 0 and ${MAX_DEPOSIT_PENCE}.`);
  }
  return value;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(raw)) {
    throw new HttpError(404, 'Not found.');
  }
  return id;
}

module.exports = {
  cleanText,
  cleanEmail,
  cleanPassword,
  cleanBoolean,
  cleanPostcode,
  cleanDate,
  cleanPence,
  parseId,
  MAX_PASSWORD_LENGTH,
};
