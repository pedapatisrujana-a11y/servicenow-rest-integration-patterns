'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createPlatform } = require('./glide-mock');
const { createRestMock } = require('./rest-mock');

function setup(responses, opts) {
  const rest = createRestMock();
  responses.forEach((r) => rest.queue.push(r));
  const p = createPlatform({}, { extraGlobals: { sn_ws: rest.sn_ws, encodeURIComponent } });
  const sleeps = [];
  p.context.gs.sleep = (ms) => sleeps.push(ms);
  p.load(path.join(__dirname, '../src/ResilientRestClient.js'));
  const client = new p.context.ResilientRestClient(Object.assign({ endpoint: 'https://api.example.test/v1/', integrationName: 'demo' }, opts));
  return { p, rest, client, sleeps };
}

test('successful GET parses JSON and sends correlation header', () => {
  const { rest, client } = setup([{ status: 200, body: { items: [1, 2] } }]);
  const r = client.get('assets', { page: 2, q: 'a b' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.body.items.length, 2);
  assert.equal(rest.sent[0].url, 'https://api.example.test/v1/assets?page=2&q=a%20b');
  assert.ok(rest.sent[0].headers['X-Correlation-ID']);
});

test('retries 503 then succeeds with exponential backoff', () => {
  const { client, sleeps } = setup([{ status: 503 }, { status: 503 }, { status: 201, body: { id: 'x' } }], { baseDelayMs: 100 });
  const r = client.post('tickets', { title: 't' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(sleeps.join(','), '100,200');
});

test('honours Retry-After on 429', () => {
  const { client, sleeps } = setup([{ status: 429, headers: { 'Retry-After': '7' } }, { status: 200, body: {} }]);
  client.get('x');
  assert.equal(sleeps[0], 7000);
});

test('does not retry 400-series client errors', () => {
  const { client } = setup([{ status: 400, body: { error: 'bad' } }]);
  const r = client.post('tickets', {});
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.equal(r.status, 400);
});

test('transport exceptions are retried and reported, never thrown', () => {
  const { client } = setup([{ throw: 'ECONNRESET' }, { throw: 'ECONNRESET' }], { maxRetries: 1 });
  const r = client.get('x');
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.match(r.error, /Transport error/);
});

test('integration log masks secrets', () => {
  const { p, client } = setup([{ status: 200, body: {} }]);
  client.post('login', { user: 'svc', password: 'FAKE-test-value', nested: { api_key: 'FAKE-test-key' } });
  const log = p.db.u_integration_log[0];
  assert.doesNotMatch(log.u_request, /FAKE-test/);
  assert.match(log.u_request, /\*\*\*\*/);
  assert.equal(log.u_success, true);
});

test('endpoint is required', () => {
  const rest = createRestMock();
  const p = createPlatform({}, { extraGlobals: { sn_ws: rest.sn_ws } });
  p.load(path.join(__dirname, '../src/ResilientRestClient.js'));
  assert.throws(() => new p.context.ResilientRestClient({}), /endpoint is required/);
});
