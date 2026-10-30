'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const compliance = require('../src/compliance');

const TODAY = '2026-10-30';

test('addMonths adds calendar months and clamps to the end of short months', () => {
  assert.equal(compliance.addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(compliance.addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(compliance.addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(compliance.addMonths('2026-03-15', 60), '2031-03-15');
  assert.equal(compliance.addMonths('2026-12-31', 2), '2027-02-28');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(compliance.addDays('2026-01-15', 30), '2026-02-14');
  assert.equal(compliance.addDays('2026-12-20', 30), '2027-01-19');
  assert.equal(compliance.addDays('2028-02-28', 1), '2028-02-29');
});

test('isValidDate rejects impossible dates, odd formats and non-strings', () => {
  assert.equal(compliance.isValidDate('2026-02-28'), true);
  assert.equal(compliance.isValidDate('2028-02-29'), true);
  assert.equal(compliance.isValidDate('2027-02-29'), false);
  assert.equal(compliance.isValidDate('2026-02-30'), false);
  assert.equal(compliance.isValidDate('30/02/2026'), false);
  assert.equal(compliance.isValidDate('2026-1-5'), false);
  assert.equal(compliance.isValidDate('2026-02-28T00:00:00Z'), false);
  assert.equal(compliance.isValidDate(null), false);
  assert.equal(compliance.isValidDate(20261030), false);
});

test('todayInLondon follows UK time, not UTC', () => {
  // 23:30 UTC on 1 July is 00:30 on 2 July in London (BST).
  assert.equal(compliance.todayInLondon(new Date('2026-07-01T23:30:00Z')), '2026-07-02');
  // In winter London is on UTC, so the same instant is still 1 July.
  assert.equal(compliance.todayInLondon(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
  assert.equal(compliance.todayInLondon(new Date('2026-01-10T12:00:00Z')), '2026-01-10');
});

test('expiring items move from valid to due soon to expired', () => {
  const gas = compliance.findItemType('gas_safety');
  const record = { completed_on: '2025-11-01', expires_on: null };

  const valid = compliance.evaluateItem(gas, record, '2026-06-01');
  assert.equal(valid.status, 'valid');
  assert.equal(valid.expires_on, '2026-11-01');

  assert.equal(compliance.evaluateItem(gas, record, '2026-09-15').status, 'due_soon');

  const expired = compliance.evaluateItem(gas, record, '2026-11-02');
  assert.equal(expired.status, 'expired');
  assert.equal(expired.days_left, -1);
});

test('the due-soon window is exactly 60 days', () => {
  const gas = compliance.findItemType('gas_safety');
  const record = { completed_on: '2025-11-01', expires_on: null };
  // 2026-11-01 is 60 days after 2026-09-02.
  assert.equal(compliance.evaluateItem(gas, record, '2026-09-02').status, 'due_soon');
  assert.equal(compliance.evaluateItem(gas, record, '2026-09-01').status, 'valid');
});

test('an item expiring today is due soon, not expired', () => {
  const gas = compliance.findItemType('gas_safety');
  const result = compliance.evaluateItem(gas, { completed_on: '2025-11-01', expires_on: null }, '2026-11-01');
  assert.equal(result.status, 'due_soon');
  assert.equal(result.days_left, 0);
});

test('a recorded expiry date overrides the default validity period', () => {
  const eicr = compliance.findItemType('eicr');
  const record = { completed_on: '2026-01-01', expires_on: '2026-06-30' };
  assert.equal(compliance.evaluateItem(eicr, record, '2026-06-01').status, 'due_soon');
});

test('the EICR default is five years and the EPC default is ten years', () => {
  const eicr = compliance.evaluateItem(compliance.findItemType('eicr'), { completed_on: '2026-03-01', expires_on: null }, TODAY);
  assert.equal(eicr.expires_on, '2031-03-01');
  const epc = compliance.evaluateItem(compliance.findItemType('epc'), { completed_on: '2026-03-01', expires_on: null }, TODAY);
  assert.equal(epc.expires_on, '2036-03-01');
});

test('one-off items are complete once a date is recorded', () => {
  const rra = compliance.findItemType('rra_information_sheet');
  assert.equal(compliance.evaluateItem(rra, null, TODAY).status, 'missing');
  assert.equal(compliance.evaluateItem(rra, { completed_on: '2026-10-01', expires_on: null }, TODAY).status, 'complete');
});

test('an HMO licence is valid only while its entered expiry is in the future', () => {
  const hmo = compliance.findItemType('hmo_licence');
  assert.equal(compliance.evaluateItem(hmo, { completed_on: null, expires_on: '2027-01-01' }, TODAY).status, 'valid');
  assert.equal(compliance.evaluateItem(hmo, { completed_on: null, expires_on: '2026-10-01' }, TODAY).status, 'expired');
  assert.equal(compliance.evaluateItem(hmo, null, TODAY).status, 'missing');
});

test('gas safety and HMO items follow the property flags', () => {
  const result = compliance.evaluateProperty({ has_gas: false, is_hmo: false }, [], TODAY);
  const types = result.items.map((item) => item.type);
  assert.ok(!types.includes('gas_safety'));
  assert.ok(!types.includes('hmo_licence'));
  assert.ok(result.not_applicable.some((item) => item.type === 'gas_safety'));
  assert.ok(result.not_applicable.some((item) => item.type === 'hmo_licence'));
  assert.equal(result.items.length, 4);
});

test('the property checklist no longer contains deposit protection, which is tracked per tenancy', () => {
  const result = compliance.evaluateProperty({ has_gas: true, is_hmo: false }, [], TODAY);
  assert.ok(!result.items.some((item) => item.type === 'deposit_protection'));
  assert.equal(result.items.length, 5);
});

test('readiness score counts valid, complete and due soon items as passing', () => {
  const records = [
    { item_type: 'eicr', completed_on: '2026-01-01', expires_on: null },
    { item_type: 'epc', completed_on: '2016-01-01', expires_on: null },
    { item_type: 'rra_information_sheet', completed_on: '2026-02-01', expires_on: null },
  ];
  const { summary } = compliance.evaluateProperty({ has_gas: false, is_hmo: false }, records, TODAY);
  // Four applicable items: EICR and the RRA sheet pass, the EPC has expired, PRS is missing.
  assert.deepEqual(summary, { compliant: 2, total: 4, score: 50 });
});

test('a property with nothing recorded scores zero, not 100', () => {
  const { summary } = compliance.evaluateProperty({ has_gas: true, is_hmo: true }, [], TODAY);
  assert.deepEqual(summary, { compliant: 0, total: 6, score: 0 });
});

test('combining no properties gives no score rather than 100%', () => {
  assert.deepEqual(compliance.combineSummaries([]), { compliant: 0, total: 0, score: null });
});

test('deposit deadline is 30 days from receipt', () => {
  const tenancy = {
    tenant_name: 'A Tenant',
    deposit_received_on: '2026-10-01',
    deposit_protected_on: null,
    prescribed_info_given_on: null,
  };
  const [protection, prescribed] = compliance.tenancyChecks(tenancy, '2026-10-20');
  assert.equal(protection.deadline, '2026-10-31');
  assert.equal(protection.status, 'due_soon');
  assert.equal(protection.days_left, 11);
  assert.equal(prescribed.status, 'due_soon');
});

test('a deposit with no receipt date has no deposit checks', () => {
  assert.deepEqual(
    compliance.tenancyChecks({ tenant_name: 'A', deposit_received_on: null }, TODAY),
    [],
  );
});

test('missing the deposit deadline is expired, and protecting late is flagged late', () => {
  const missed = compliance.tenancyChecks(
    { tenant_name: 'Missed', deposit_received_on: '2026-09-01', deposit_protected_on: null, prescribed_info_given_on: '2026-09-10' },
    TODAY,
  );
  assert.equal(missed[0].status, 'expired');
  assert.equal(missed[1].status, 'complete');

  const late = compliance.tenancyChecks(
    { tenant_name: 'Late', deposit_received_on: '2026-09-01', deposit_protected_on: '2026-10-05', prescribed_info_given_on: null },
    TODAY,
  );
  assert.equal(late[0].status, 'late');
  assert.equal(late[0].done_on, '2026-10-05');
});

test('protecting on the deadline day itself is still on time', () => {
  const onTime = compliance.tenancyChecks(
    { tenant_name: 'Edge', deposit_received_on: '2026-10-01', deposit_protected_on: '2026-10-31', prescribed_info_given_on: null },
    TODAY,
  );
  assert.equal(onTime[0].status, 'complete');
});

test('reminder buckets: 7 days, 30 days, expired, and nothing otherwise', () => {
  assert.equal(compliance.reminderBucket('expired', -3), 'expired');
  assert.equal(compliance.reminderBucket('due_soon', 0), '7');
  assert.equal(compliance.reminderBucket('due_soon', 7), '7');
  assert.equal(compliance.reminderBucket('due_soon', 8), '30');
  assert.equal(compliance.reminderBucket('due_soon', 30), '30');
  assert.equal(compliance.reminderBucket('due_soon', 31), null);
  assert.equal(compliance.reminderBucket('valid', 200), null);
  assert.equal(compliance.reminderBucket('missing', null), null);
  assert.equal(compliance.reminderBucket('late', -5), null);
});

test('attention items sort by urgency (expired and late first), then by days left', () => {
  const items = [
    { status: 'due_soon', days_left: 5 },
    { status: 'expired', days_left: -20 },
    { status: 'missing', days_left: null },
    { status: 'expired', days_left: -2 },
    { status: 'late', days_left: -9 },
    { status: 'valid', days_left: 400 },
  ];
  const sorted = items.filter(compliance.needsAttention).sort(compliance.compareUrgency);
  assert.deepEqual(
    sorted.map((item) => [item.status, item.days_left]),
    [
      ['expired', -20],
      ['late', -9],
      ['expired', -2],
      ['missing', null],
      ['due_soon', 5],
    ],
  );
});
