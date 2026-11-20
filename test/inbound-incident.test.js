'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createPlatform } = require('./glide-mock');
const { alerts } = require('../data/sample-alerts.json');

function setup() {
  const p = createPlatform({
    incident: [],
    cmdb_ci: [{ sys_id: 'ci001', name: 'web-prd-01', operational_status: '1' }],
  }, { properties: { 'x_portfolio.inbound.default_group': 'grp_noc' } });
  p.load(path.join(__dirname, '../src/InboundIncidentHandler.js'));
  return { p, h: new p.context.InboundIncidentHandler() };
}

test('creates incident with mapped impact/urgency, CI and default group', () => {
  const { p, h } = setup();
  const r = h.process(alerts[0]);
  assert.equal(r.status, 201);
  assert.equal(r.body.ci_matched, true);
  const inc = p.db.incident[0];
  assert.equal(inc.impact, '2');
  assert.equal(inc.urgency, '1');
  assert.equal(inc.cmdb_ci, 'ci001');
  assert.equal(inc.assignment_group, 'grp_noc');
  assert.equal(inc.correlation_id, 'mon-0001');
});

test('repeat event with the same external_id is idempotent', () => {
  const { p, h } = setup();
  h.process(alerts[0]);
  const r = h.process(alerts[2]);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'updated');
  assert.equal(p.db.incident.length, 1);
});

test('closed incident does not block a new one', () => {
  const { p, h } = setup();
  h.process(alerts[0]);
  p.db.incident[0].state = '7';
  const r = h.process(alerts[2]);
  assert.equal(r.status, 201);
  assert.equal(p.db.incident.length, 2);
});

test('invalid payload returns 400 with all validation errors', () => {
  const { h } = setup();
  const r = h.process(alerts[3]);
  assert.equal(r.status, 400);
  assert.equal(r.body.errors.length, 3);
});

test('non-object body is rejected', () => {
  const { h } = setup();
  assert.equal(h.process(null).status, 400);
});

test('unexpected errors return 500 without leaking details', () => {
  const { p, h } = setup();
  p.context.GlideRecord.prototype.query = () => { throw new Error('db down'); };
  const r = h.process(alerts[1]);
  assert.equal(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.body), /db down/);
  assert.ok(p.logs.some(([l, m]) => l === 'error' && /db down/.test(m)));
});
