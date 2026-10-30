'use strict';

const compliance = require('./compliance');
const store = require('./store');

// Builds the full property view used by the API and the front end.
// The readiness score covers the property checklist only. Deposit deadlines
// are shown per tenancy and are not part of the score.
function buildPropertyDetail(db, property, today) {
  const evaluated = compliance.evaluateProperty(property, store.loadRecords(db, property.id), today);
  const documents = store.loadDocuments(db, property.id);

  const items = evaluated.items.map((item) => ({
    ...item,
    documents: documents.filter((doc) => doc.item_type === item.type),
  }));

  const tenancies = store.loadTenancies(db, property.id).map((tenancy) => ({
    ...tenancy,
    checks: compliance.tenancyChecks(tenancy, today),
  }));

  return {
    property,
    items,
    not_applicable: evaluated.not_applicable,
    summary: evaluated.summary,
    tenancies,
  };
}

// Everything that needs action on a property, most urgent first.
function attentionFromDetail(detail) {
  const fromItems = detail.items.filter(compliance.needsAttention).map((item) => ({
    key: item.type,
    label: item.label,
    status: item.status,
    days_left: item.days_left,
    expires_on: item.expires_on,
    one_off: item.one_off,
  }));

  const fromTenancies = detail.tenancies.flatMap((tenancy) =>
    tenancy.checks.filter(compliance.needsAttention).map((check) => ({
      key: `tenancy:${tenancy.id}:${check.key}`,
      label: check.label,
      status: check.status,
      days_left: check.days_left,
      expires_on: check.deadline,
      one_off: false,
    })),
  );

  return [...fromItems, ...fromTenancies].sort(compliance.compareUrgency);
}

module.exports = { buildPropertyDetail, attentionFromDetail };
