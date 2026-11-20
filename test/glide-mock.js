'use strict';
/**
 * Minimal, in-memory stand-in for the ServiceNow server-side APIs used in this repo
 * (GlideRecord, gs, Class). It exists only so the Script Includes can be unit-tested
 * with Node's built-in test runner. It is NOT a full emulation of the platform.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createPlatform(tables = {}, options = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const logs = [];
  let sysIdSeq = 1000;
  const now = options.now ? new Date(options.now) : new Date();

  function GlideRecord(table) {
    this._table = table;
    this._conds = [];
    this._rows = [];
    this._idx = -1;
    this._limit = Infinity;
    this._orderBy = null;
    this._new = null;
  }
  GlideRecord.prototype = {
    addQuery(field, op, value) {
      if (arguments.length === 2) { value = op; op = '='; }
      this._conds.push({ field, op, value });
    },
    addEncodedQuery(q) {
      String(q).split('^').filter(Boolean).forEach((part) => {
        const m = part.match(/^(\w+)(=|!=|IN|ISEMPTY|ISNOTEMPTY)(.*)$/);
        if (!m) throw new Error('Unsupported encoded query: ' + part);
        if (m[2] === 'IN') this._conds.push({ field: m[1], op: 'IN', value: m[3].split(',') });
        else if (m[2] === 'ISEMPTY') this._conds.push({ field: m[1], op: 'ISEMPTY' });
        else if (m[2] === 'ISNOTEMPTY') this._conds.push({ field: m[1], op: 'ISNOTEMPTY' });
        else this._conds.push({ field: m[1], op: m[2], value: m[3] });
      });
    },
    addNullQuery(field) { this._conds.push({ field, op: 'ISEMPTY' }); },
    addNotNullQuery(field) { this._conds.push({ field, op: 'ISNOTEMPTY' }); },
    orderBy(field) { this._orderBy = field; },
    setLimit(n) { this._limit = n; },
    query() {
      const rows = (db[this._table] || []).filter((r) => this._conds.every((c) => match(r, c)));
      if (this._orderBy) rows.sort((a, b) => String(a[this._orderBy]).localeCompare(String(b[this._orderBy])));
      this._rows = rows.slice(0, this._limit);
      this._idx = -1;
    },
    next() {
      this._idx += 1;
      if (this._idx < this._rows.length) { this._bind(this._rows[this._idx]); return true; }
      return false;
    },
    hasNext() { return this._idx + 1 < this._rows.length; },
    get(field, value) {
      if (arguments.length === 1) { value = field; field = 'sys_id'; }
      const row = (db[this._table] || []).find((r) => String(r[field]) === String(value));
      if (row) { this._rows = [row]; this._idx = 0; this._bind(row); return true; }
      return false;
    },
    getRowCount() { return this._rows.length; },
    getValue(field) { const r = this._current(); return r && r[field] !== undefined && r[field] !== null ? String(r[field]) : null; },
    getDisplayValue(field) { return this.getValue(field || 'name'); },
    setValue(field, value) { this._target()[field] = value; this[field] = value; },
    getUniqueValue() { return this.getValue('sys_id'); },
    getTableName() { return this._table; },
    isValidRecord() { return !!this._current(); },
    initialize() { this._new = {}; },
    newRecord() { this._new = {}; },
    insert() {
      const rec = Object.assign({ sys_id: 'sys' + (sysIdSeq++) }, this._new);
      // emulate platform auto-numbering for task tables
      const prefixes = { incident: 'INC', sn_hr_core_case: 'HRC', sc_req_item: 'RITM', sysapproval_approver: 'APR' };
      if (prefixes[this._table] && !rec.number) rec.number = prefixes[this._table] + String(10000 + (db[this._table] || []).length + 1).padStart(7, '0');
      (db[this._table] = db[this._table] || []).push(rec);
      this._new = null; this._rows = [rec]; this._idx = 0; this._bind(rec);
      return rec.sys_id;
    },
    update() {
      const r = this._current();
      Object.keys(this).forEach((k) => { if (!k.startsWith('_') && typeof this[k] !== 'function' && r) r[k] = this[k]; });
      return r ? r.sys_id : null;
    },
    _current() { return this._new || this._rows[this._idx]; },
    _target() { return this._new || this._rows[this._idx]; },
    _bind(row) {
      Object.keys(row).forEach((k) => { this[k] = row[k]; });
    },
  };

  function match(row, c) {
    const v = row[c.field];
    const empty = v === undefined || v === null || v === '';
    switch (c.op) {
      case '=': return String(v) === String(c.value);
      case '!=': return String(v) !== String(c.value);
      case 'IN': return [].concat(c.value).map(String).includes(String(v));
      case 'ISEMPTY': return empty;
      case 'ISNOTEMPTY': return !empty;
      case '>': return Number(v) > Number(c.value);
      case '<': return Number(v) < Number(c.value);
      default: throw new Error('Unsupported operator ' + c.op);
    }
  }

  const gs = {
    info: (...a) => logs.push(['info', fmt(a)]),
    warn: (...a) => logs.push(['warn', fmt(a)]),
    error: (...a) => logs.push(['error', fmt(a)]),
    debug: (...a) => logs.push(['debug', fmt(a)]),
    nowDateTime: () => now.toISOString().replace('T', ' ').slice(0, 19),
    nowNoTZ: () => now.toISOString().replace('T', ' ').slice(0, 19),
    generateGUID: () => 'guid' + (sysIdSeq++),
    getProperty: (name, dflt) => (options.properties && name in options.properties ? options.properties[name] : dflt),
    nil: (v) => v === undefined || v === null || v === '',
    getUserID: () => options.userId || 'user.test',
    sleep: () => {},
  };
  function fmt(a) { let s = String(a[0]); a.slice(1).forEach((x, i) => { s = s.replace('{' + i + '}', String(x)); }); return s; }

  const Class = { create: () => function () { if (this.initialize) this.initialize.apply(this, arguments); } };

  const context = { GlideRecord, gs, Class, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, console, __now: now };
  if (options.extraGlobals) Object.assign(context, options.extraGlobals);
  vm.createContext(context);

  return {
    db, logs, context,
    load(file) {
      const code = fs.readFileSync(path.resolve(file), 'utf8');
      vm.runInContext(code, context, { filename: file });
      return context;
    },
  };
}

module.exports = { createPlatform };
