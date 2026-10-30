'use strict';

const compliance = require('../compliance');
const { transaction } = require('../db');
const { HttpError } = require('../errors');
const files = require('../files');
const store = require('../store');
const validate = require('../validate');
const { ownedProperty } = require('./common');

const MAX_DOCUMENTS_PER_ITEM = 10;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) {
    throw new HttpError(400, 'The file data is not valid base64.');
  }
  // Each base64 character carries 6 bits, so the decoded size is known before decoding.
  const estimatedBytes = (text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  if (estimatedBytes > files.MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, `Files must be ${files.MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller.`);
  }
  return Buffer.from(text, 'base64');
}

function uploadDocument({ db, user, params, body, today }) {
  const propertyId = validate.parseId(params.id);
  const property = ownedProperty(db, user.id, propertyId, store);
  const definition = compliance.findItemType(params.type);
  if (!definition) throw new HttpError(404, 'Unknown compliance item.');
  if (!definition.appliesTo(property)) throw new HttpError(400, 'This item does not apply to this property.');

  const contentType = typeof body.content_type === 'string' ? body.content_type.toLowerCase() : '';
  if (!files.ALLOWED_TYPES.includes(contentType)) {
    throw new HttpError(400, 'Upload a PDF, JPEG or PNG file.');
  }
  const data = decodeBase64(body.data);
  if (data.length === 0) throw new HttpError(400, 'The file is empty.');
  if (!files.matchesDeclaredType(data, contentType)) {
    throw new HttpError(400, 'The file contents do not match its type. Upload the original PDF, JPEG or PNG.');
  }
  const filename = files.sanitizeFilename(body.filename);

  // The count and the insert share one transaction, so concurrent uploads cannot exceed the limit.
  return transaction(db, () => {
    const count = db
      .prepare('SELECT COUNT(*) AS total FROM documents WHERE property_id = ? AND item_type = ?')
      .get(propertyId, definition.type).total;
    if (count >= MAX_DOCUMENTS_PER_ITEM) {
      throw new HttpError(400, `Each item can have up to ${MAX_DOCUMENTS_PER_ITEM} files. Remove one first.`);
    }
    const result = db
      .prepare(
        'INSERT INTO documents (property_id, item_type, filename, content_type, size_bytes, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(propertyId, definition.type, filename, contentType, data.length, data);
    return {
      status: 201,
      body: { id: Number(result.lastInsertRowid), filename, content_type: contentType, size_bytes: data.length },
    };
  });
}

function findOwnedDocument(db, userId, rawId) {
  const id = validate.parseId(rawId);
  const row = db
    .prepare(
      `SELECT d.* FROM documents d JOIN properties p ON p.id = d.property_id
       WHERE d.id = ? AND p.user_id = ?`,
    )
    .get(id, userId);
  if (!row) throw new HttpError(404, 'Document not found.');
  return row;
}

function downloadDocument({ db, user, params }) {
  const row = findOwnedDocument(db, user.id, params.id);
  return {
    raw: {
      contentType: row.content_type,
      filename: row.filename,
      data: row.data,
    },
  };
}

function deleteDocument({ db, user, params }) {
  const row = findOwnedDocument(db, user.id, params.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
  return { body: { ok: true } };
}

module.exports = { uploadDocument, downloadDocument, deleteDocument };
