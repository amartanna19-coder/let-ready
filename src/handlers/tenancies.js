'use strict';

const { buildPropertyDetail } = require('../details');
const { HttpError } = require('../errors');
const store = require('../store');
const validate = require('../validate');
const { ownedProperty } = require('./common');

function cleanTenancyInput(body, existing) {
  const source = { ...existing, ...body };
  const input = {
    tenant_name: validate.cleanText(source.tenant_name, { field: 'Tenant name', max: 120, required: true }),
    start_date: validate.cleanDate(source.start_date, 'Tenancy start date', { required: true }),
    deposit_amount_pence: validate.cleanPence(source.deposit_amount_pence, 'Deposit amount'),
    deposit_received_on: validate.cleanDate(source.deposit_received_on, 'Date deposit received'),
    deposit_protected_on: validate.cleanDate(source.deposit_protected_on, 'Date deposit protected'),
    prescribed_info_given_on: validate.cleanDate(source.prescribed_info_given_on, 'Date prescribed information given'),
    notes: validate.cleanText(source.notes, { field: 'Notes', max: 1000, singleLine: false }),
  };

  if (!input.deposit_received_on && (input.deposit_protected_on || input.prescribed_info_given_on)) {
    throw new HttpError(400, 'Enter the date the deposit was received before recording protection or prescribed information.');
  }
  if (input.deposit_protected_on && input.deposit_protected_on < input.deposit_received_on) {
    throw new HttpError(400, 'The deposit cannot be protected before it was received.');
  }
  return input;
}

function createTenancy({ db, user, params, body, today }) {
  const propertyId = validate.parseId(params.id);
  ownedProperty(db, user.id, propertyId, store);
  const input = cleanTenancyInput(body, {});
  const result = db
    .prepare(
      `INSERT INTO tenancies (property_id, tenant_name, start_date, deposit_amount_pence, deposit_received_on,
         deposit_protected_on, prescribed_info_given_on, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      propertyId,
      input.tenant_name,
      input.start_date,
      input.deposit_amount_pence,
      input.deposit_received_on,
      input.deposit_protected_on,
      input.prescribed_info_given_on,
      input.notes,
    );
  const property = ownedProperty(db, user.id, propertyId, store);
  return { status: 201, body: { id: Number(result.lastInsertRowid), ...buildPropertyDetail(db, property, today()) } };
}

function updateTenancy({ db, user, params, body, today }) {
  const propertyId = validate.parseId(params.id);
  const tenancyId = validate.parseId(params.tenancyId);
  ownedProperty(db, user.id, propertyId, store);
  const row = store.getTenancyRow(db, propertyId, tenancyId);
  if (!row) throw new HttpError(404, 'Tenancy not found.');

  const input = cleanTenancyInput(body, store.toTenancy(row));
  db.prepare(
    `UPDATE tenancies SET tenant_name = ?, start_date = ?, deposit_amount_pence = ?, deposit_received_on = ?,
       deposit_protected_on = ?, prescribed_info_given_on = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ? AND property_id = ?`,
  ).run(
    input.tenant_name,
    input.start_date,
    input.deposit_amount_pence,
    input.deposit_received_on,
    input.deposit_protected_on,
    input.prescribed_info_given_on,
    input.notes,
    tenancyId,
    propertyId,
  );
  const property = ownedProperty(db, user.id, propertyId, store);
  return { body: buildPropertyDetail(db, property, today()) };
}

function deleteTenancy({ db, user, params, today }) {
  const propertyId = validate.parseId(params.id);
  const tenancyId = validate.parseId(params.tenancyId);
  const property = ownedProperty(db, user.id, propertyId, store);
  if (!store.getTenancyRow(db, propertyId, tenancyId)) throw new HttpError(404, 'Tenancy not found.');
  db.prepare('DELETE FROM tenancies WHERE id = ? AND property_id = ?').run(tenancyId, propertyId);
  return { body: buildPropertyDetail(db, property, today()) };
}

module.exports = { createTenancy, updateTenancy, deleteTenancy };
