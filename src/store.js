'use strict';

// Read helpers shared by the HTTP handlers and the background reminder job.
// Every query that touches user data is scoped by user_id or property_id.

function toProperty(row) {
  return {
    id: row.id,
    address: row.address,
    postcode: row.postcode,
    borough: row.borough,
    has_gas: row.has_gas === 1,
    is_hmo: row.is_hmo === 1,
  };
}

function listProperties(db, userId) {
  return db.prepare('SELECT * FROM properties WHERE user_id = ? ORDER BY id').all(userId).map(toProperty);
}

function getPropertyRow(db, userId, id) {
  return db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(id, userId);
}

function loadRecords(db, propertyId) {
  return db
    .prepare(
      'SELECT item_type, completed_on, expires_on, reference, notes FROM compliance_records WHERE property_id = ?',
    )
    .all(propertyId);
}

function toTenancy(row) {
  return {
    id: row.id,
    tenant_name: row.tenant_name,
    start_date: row.start_date,
    deposit_amount_pence: row.deposit_amount_pence,
    deposit_received_on: row.deposit_received_on,
    deposit_protected_on: row.deposit_protected_on,
    prescribed_info_given_on: row.prescribed_info_given_on,
    notes: row.notes,
  };
}

function loadTenancies(db, propertyId) {
  return db
    .prepare('SELECT * FROM tenancies WHERE property_id = ? ORDER BY start_date DESC, id DESC')
    .all(propertyId)
    .map(toTenancy);
}

function getTenancyRow(db, propertyId, id) {
  return db.prepare('SELECT * FROM tenancies WHERE id = ? AND property_id = ?').get(id, propertyId);
}

function loadDocuments(db, propertyId) {
  return db
    .prepare(
      `SELECT id, item_type, filename, content_type, size_bytes, uploaded_at
       FROM documents WHERE property_id = ? ORDER BY uploaded_at DESC, id DESC`,
    )
    .all(propertyId);
}

module.exports = {
  toProperty,
  listProperties,
  getPropertyRow,
  loadRecords,
  toTenancy,
  loadTenancies,
  getTenancyRow,
  loadDocuments,
};
