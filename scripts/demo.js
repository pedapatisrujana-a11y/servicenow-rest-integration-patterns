'use strict';
// Replays the synthetic alerts through the inbound handler and prints the API responses.
const path = require('path');
const { createPlatform } = require('../test/glide-mock');
const { alerts } = require('../data/sample-alerts.json');
const p = createPlatform({ incident: [], cmdb_ci: [{ sys_id: 'ci001', name: 'web-prd-01', operational_status: '1' }] });
p.load(path.join(__dirname, '../src/InboundIncidentHandler.js'));
const h = new p.context.InboundIncidentHandler();
for (const a of alerts) {
  const r = h.process(a);
  console.log(`${String(r.status).padEnd(4)} ${a.external_id.padEnd(9)} -> ${JSON.stringify(r.body)}`);
}
