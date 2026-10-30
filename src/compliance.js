'use strict';

// Rules for each property compliance item. Sources are listed in docs/SOURCES.md.
// Validity periods are defaults; a landlord can override any expiry date with
// the one printed on the certificate or licence.
const DUE_SOON_DAYS = 60;
const DEPOSIT_DEADLINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ITEM_TYPES = [
  {
    type: 'gas_safety',
    label: 'Gas safety certificate (CP12)',
    guidance:
      'Annual gas safety check by a Gas Safe registered engineer, for properties with gas appliances or a gas supply. Give existing tenants the record within 28 days of the check, and new tenants before they move in. Keep records for at least two years.',
    validMonths: 12,
    appliesTo: (property) => property.has_gas,
  },
  {
    type: 'eicr',
    label: 'Electrical installation condition report (EICR)',
    guidance:
      'Electrical safety report, at intervals of no more than 5 years, or shorter if the last report says so. Give tenants a copy. Enter a shorter expiry date if your inspector recommends one.',
    validMonths: 60,
    appliesTo: () => true,
  },
  {
    type: 'epc',
    label: 'Energy performance certificate (EPC)',
    guidance:
      'Valid for 10 years. Rentals generally need a rating of E or above unless a valid exemption is registered. Gov.uk should be checked for any proposed changes to the minimum rating.',
    validMonths: 120,
    appliesTo: () => true,
  },
  {
    type: 'hmo_licence',
    label: 'HMO licence',
    guidance:
      'Needed for houses in multiple occupation with five or more occupants forming two or more households. Licences usually last up to five years. Enter the expiry date shown on your licence.',
    expiryRequired: true,
    appliesTo: (property) => property.is_hmo,
  },
  {
    type: 'rra_information_sheet',
    label: "Renters' Rights Act information sheet given to tenant",
    guidance:
      'Record the date you gave the tenant the required information sheet. Check gov.uk for the exact requirement and timing.',
    oneOff: true,
    appliesTo: () => true,
  },
  {
    type: 'prs_database',
    label: 'Registered on the PRS Database',
    guidance:
      'Record the date the property was registered on the Private Rented Sector Database. Registration opens in stages from December 2026, so check gov.uk for the deadline in your area.',
    oneOff: true,
    appliesTo: () => true,
  },
];

// Lower number = more urgent. 'late' is a deposit step completed after its deadline.
const URGENCY = { expired: 0, late: 0, missing: 1, due_soon: 2 };
const COMPLIANT_STATUSES = new Set(['valid', 'complete', 'due_soon']);

function findItemType(type) {
  return ITEM_TYPES.find((definition) => definition.type === type) || null;
}

function todayInLondon(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isValidDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function addMonths(isoDate, months) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalisedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalisedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(Date.UTC(targetYear, normalisedMonth, clampedDay)).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function evaluateItem(definition, record, today) {
  const completedOn = record ? record.completed_on : null;

  if (definition.oneOff) {
    return completedOn
      ? { status: 'complete', expires_on: null, days_left: null }
      : { status: 'missing', expires_on: null, days_left: null };
  }

  let expiresOn = null;
  if (record && record.expires_on) {
    expiresOn = record.expires_on;
  } else if (completedOn && definition.validMonths) {
    expiresOn = addMonths(completedOn, definition.validMonths);
  }

  if (!expiresOn) return { status: 'missing', expires_on: null, days_left: null };

  const daysLeft = daysBetween(today, expiresOn);
  let status = 'valid';
  if (daysLeft < 0) status = 'expired';
  else if (daysLeft <= DUE_SOON_DAYS) status = 'due_soon';
  return { status, expires_on: expiresOn, days_left: daysLeft };
}

function evaluateProperty(property, records, today) {
  const recordsByType = new Map(records.map((record) => [record.item_type, record]));
  const items = [];
  const notApplicable = [];

  for (const definition of ITEM_TYPES) {
    if (!definition.appliesTo(property)) {
      notApplicable.push({ type: definition.type, label: definition.label });
      continue;
    }
    const record = recordsByType.get(definition.type) || null;
    items.push({
      type: definition.type,
      label: definition.label,
      guidance: definition.guidance,
      one_off: !!definition.oneOff,
      expiry_required: !!definition.expiryRequired,
      ...evaluateItem(definition, record, today),
      record: record
        ? {
            completed_on: record.completed_on,
            expires_on: record.expires_on,
            reference: record.reference,
            notes: record.notes,
          }
        : null,
    });
  }

  const compliant = items.filter((item) => COMPLIANT_STATUSES.has(item.status)).length;
  return { items, not_applicable: notApplicable, summary: summary(compliant, items.length) };
}

// Deposit rules: protect the deposit and give the prescribed information within
// 30 days of receiving it. Both steps are tracked per tenancy.
function deadlineCheck({ key, label, deadline, doneOn, today }) {
  const daysLeft = daysBetween(today, deadline);
  if (doneOn) {
    const late = doneOn > deadline;
    return { key, label, deadline, done_on: doneOn, status: late ? 'late' : 'complete', days_left: daysLeft };
  }
  return { key, label, deadline, done_on: null, status: daysLeft < 0 ? 'expired' : 'due_soon', days_left: daysLeft };
}

function tenancyChecks(tenancy, today) {
  if (!tenancy.deposit_received_on) return [];
  const deadline = addDays(tenancy.deposit_received_on, DEPOSIT_DEADLINE_DAYS);
  return [
    deadlineCheck({
      key: 'deposit_protection',
      label: `Deposit protected for ${tenancy.tenant_name}`,
      deadline,
      doneOn: tenancy.deposit_protected_on,
      today,
    }),
    deadlineCheck({
      key: 'prescribed_information',
      label: `Prescribed information given to ${tenancy.tenant_name}`,
      deadline,
      doneOn: tenancy.prescribed_info_given_on,
      today,
    }),
  ];
}

function summary(compliant, total) {
  return { compliant, total, score: total ? Math.round((100 * compliant) / total) : null };
}

function combineSummaries(summaries) {
  const compliant = summaries.reduce((sum, entry) => sum + entry.compliant, 0);
  const total = summaries.reduce((sum, entry) => sum + entry.total, 0);
  return summary(compliant, total);
}

function needsAttention(item) {
  return Object.hasOwn(URGENCY, item.status);
}

function compareUrgency(a, b) {
  const byStatus = URGENCY[a.status] - URGENCY[b.status];
  if (byStatus !== 0) return byStatus;
  const leftA = a.days_left ?? Number.MAX_SAFE_INTEGER;
  const leftB = b.days_left ?? Number.MAX_SAFE_INTEGER;
  return leftA - leftB;
}

// Reminder buckets: each deadline sends at most one reminder per bucket.
function reminderBucket(status, daysLeft) {
  if (status === 'expired') return 'expired';
  if (status !== 'due_soon' || daysLeft === null) return null;
  if (daysLeft <= 7) return '7';
  if (daysLeft <= 30) return '30';
  return null;
}

module.exports = {
  ITEM_TYPES,
  DUE_SOON_DAYS,
  DEPOSIT_DEADLINE_DAYS,
  findItemType,
  todayInLondon,
  isValidDate,
  addMonths,
  addDays,
  daysBetween,
  evaluateItem,
  evaluateProperty,
  tenancyChecks,
  combineSummaries,
  needsAttention,
  compareUrgency,
  reminderBucket,
};
