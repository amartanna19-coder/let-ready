'use strict';

const compliance = require('../compliance');
const { buildPropertyDetail } = require('../details');
const { HttpError } = require('../errors');
const store = require('../store');
const { toCsv } = require('../csv');
const validate = require('../validate');
const { ownedProperty } = require('./common');

const DEFAULT_PROPERTY = { has_gas: true, is_hmo: false, borough: null };

function cleanPropertyInput(body, existing) {
  const source = { ...existing, ...body };
  return {
    address: validate.cleanText(source.address, { field: 'Address', max: 200, required: true }),
    postcode: validate.cleanPostcode(source.postcode),
    borough: validate.cleanText(source.borough, { field: 'Borough', max: 60 }),
    has_gas: validate.cleanBoolean(source.has_gas, 'Gas appliances'),
    is_hmo: validate.cleanBoolean(source.is_hmo, 'HMO'),
  };
}

const bit = (value) => (value ? 1 : 0);

function createProperty({ db, user, body }) {
  const input = cleanPropertyInput(body, DEFAULT_PROPERTY);
  const result = db
    .prepare(
      'INSERT INTO properties (user_id, address, postcode, borough, has_gas, is_hmo) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(user.id, input.address, input.postcode, input.borough, bit(input.has_gas), bit(input.is_hmo));
  return { status: 201, body: { id: Number(result.lastInsertRowid) } };
}

function getProperty({ db, user, params, today }) {
  const property = ownedProperty(db, user.id, validate.parseId(params.id), store);
  return { body: buildPropertyDetail(db, property, today()) };
}

function updateProperty({ db, user, params, body, today }) {
  const id = validate.parseId(params.id);
  const existing = ownedProperty(db, user.id, id, store);
  const input = cleanPropertyInput(body, existing);
  db.prepare(
    'UPDATE properties SET address = ?, postcode = ?, borough = ?, has_gas = ?, is_hmo = ? WHERE id = ? AND user_id = ?',
  ).run(input.address, input.postcode, input.borough, bit(input.has_gas), bit(input.is_hmo), id, user.id);
  const property = ownedProperty(db, user.id, id, store);
  return { body: buildPropertyDetail(db, property, today()) };
}

function deleteProperty({ db, user, params }) {
  const id = validate.parseId(params.id);
  ownedProperty(db, user.id, id, store);
  db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').run(id, user.id);
  return { body: { ok: true } };
}

function saveItem({ db, user, params, body, today }) {
  const id = validate.parseId(params.id);
  const property = ownedProperty(db, user.id, id, store);
  const definition = compliance.findItemType(params.type);
  if (!definition) throw new HttpError(404, 'Unknown compliance item.');
  if (!definition.appliesTo(property)) throw new HttpError(400, 'This item does not apply to this property.');

  const completedOn = validate.cleanDate(body.completed_on, 'Date completed', { required: !definition.expiryRequired });
  const expiresOn = definition.oneOff
    ? null
    : validate.cleanDate(body.expires_on, 'Expiry date', { required: !!definition.expiryRequired });
  if (completedOn && expiresOn && expiresOn <= completedOn) {
    throw new HttpError(400, 'Expiry date must be after the date completed.');
  }
  const reference = validate.cleanText(body.reference, { field: 'Reference', max: 100 });
  const notes = validate.cleanText(body.notes, { field: 'Notes', max: 1000, singleLine: false });

  db.prepare(
    `INSERT INTO compliance_records (property_id, item_type, completed_on, expires_on, reference, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (property_id, item_type) DO UPDATE SET
       completed_on = excluded.completed_on,
       expires_on = excluded.expires_on,
       reference = excluded.reference,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(id, definition.type, completedOn, expiresOn, reference, notes);

  return { body: buildPropertyDetail(db, property, today()) };
}

function deleteItem({ db, user, params, today }) {
  const id = validate.parseId(params.id);
  const property = ownedProperty(db, user.id, id, store);
  if (!compliance.findItemType(params.type)) throw new HttpError(404, 'Unknown compliance item.');
  db.prepare('DELETE FROM compliance_records WHERE property_id = ? AND item_type = ?').run(id, params.type);
  return { body: buildPropertyDetail(db, property, today()) };
}

// A CSV that an agent, council or buyer can open in a spreadsheet.
function exportPropertyCsv({ db, user, params, today }) {
  const id = validate.parseId(params.id);
  const property = ownedProperty(db, user.id, id, store);
  const detail = buildPropertyDetail(db, property, today());

  const rows = [
    ['Check', 'Status', 'Date completed or deadline', 'Expires or due', 'Reference', 'Notes', 'Documents attached'],
    ...detail.items.map((item) => [
      item.label,
      item.status,
      item.record ? item.record.completed_on : '',
      item.expires_on || '',
      item.record ? item.record.reference : '',
      item.record ? item.record.notes : '',
      item.documents.map((doc) => doc.filename).join('; '),
    ]),
    ...detail.tenancies.flatMap((tenancy) =>
      tenancy.checks.map((check) => [
        `${check.label} (tenancy starting ${tenancy.start_date})`,
        check.status,
        check.done_on || '',
        check.deadline,
        '',
        '',
        '',
      ]),
    ),
  ];

  const slug = property.postcode.replace(/\s+/g, '-').toLowerCase();
  return {
    raw: {
      contentType: 'text/csv; charset=utf-8',
      filename: `let-ready-${slug}-${property.id}.csv`,
      data: Buffer.from(toCsv(rows), 'utf8'),
    },
  };
}

module.exports = {
  createProperty,
  getProperty,
  updateProperty,
  deleteProperty,
  saveItem,
  deleteItem,
  exportPropertyCsv,
};
