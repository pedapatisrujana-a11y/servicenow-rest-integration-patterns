/**
 * Script Include: ResilientRestClient
 * Accessible from: server-side only
 *
 * Wrapper around sn_ws.RESTMessageV2 for outbound integrations that adds:
 *   - retries with exponential backoff for 429 / 5xx / transport errors
 *   - a correlation id header on every call (end-to-end tracing)
 *   - structured logging to an integration log table, with secrets masked
 *   - consistent result object instead of exceptions leaking to callers
 *
 * Endpoints and credentials are expected to come from a Connection & Credential
 * alias or system properties — never hard-coded.
 *
 * Portfolio project: written independently with synthetic data. Not client code.
 */
var ResilientRestClient = Class.create();
ResilientRestClient.prototype = {

    /**
     * @param {Object} opts
     * @param {string} opts.endpoint          base URL (e.g. from a system property)
     * @param {number} [opts.maxRetries=3]
     * @param {number} [opts.baseDelayMs=500]
     * @param {number} [opts.timeoutMs=30000]
     * @param {string} [opts.logTable='u_integration_log']
     * @param {string} [opts.integrationName='generic']
     * @param {string} [opts.credentialAlias]  optional Connection & Credential alias sys_id
     */
    initialize: function (opts) {
        opts = opts || {};
        if (!opts.endpoint) throw new Error('ResilientRestClient: endpoint is required');
        this.endpoint = String(opts.endpoint).replace(/\/+$/, '');
        this.maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 3;
        this.baseDelayMs = typeof opts.baseDelayMs === 'number' ? opts.baseDelayMs : 500;
        this.timeoutMs = opts.timeoutMs || 30000;
        this.logTable = opts.logTable || 'u_integration_log';
        this.integrationName = opts.integrationName || 'generic';
        this.credentialAlias = opts.credentialAlias || null;
        this.retryableStatus = [408, 429, 500, 502, 503, 504];
    },

    get: function (path, query) { return this.send('GET', path, null, query); },
    post: function (path, body) { return this.send('POST', path, body); },
    patch: function (path, body) { return this.send('PATCH', path, body); },

    /**
     * @returns {{ok:boolean, status:number, body:Object|string|null, attempts:number, correlationId:string, error:string|null}}
     */
    send: function (method, path, body, query) {
        var correlationId = gs.generateGUID();
        var url = this.endpoint + (path ? '/' + String(path).replace(/^\/+/, '') : '') + this._queryString(query);
        var attempt = 0;
        var last = { ok: false, status: 0, body: null, error: null };

        while (attempt <= this.maxRetries) {
            attempt++;
            last = this._execute(method, url, body, correlationId);
            if (last.ok || !this._isRetryable(last)) break;
            if (attempt <= this.maxRetries) gs.sleep(this._backoff(attempt, last.retryAfterMs));
        }

        var result = {
            ok: last.ok,
            status: last.status,
            body: last.body,
            attempts: attempt,
            correlationId: correlationId,
            error: last.ok ? null : (last.error || 'HTTP ' + last.status)
        };
        this._log(method, url, body, result);
        return result;
    },

    _execute: function (method, url, body, correlationId) {
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setHttpMethod(method);
            rm.setEndpoint(url);
            rm.setHttpTimeout(this.timeoutMs);
            rm.setRequestHeader('Accept', 'application/json');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestHeader('X-Correlation-ID', correlationId);
            if (this.credentialAlias) rm.setAuthenticationProfile('basic', this.credentialAlias);
            if (body !== null && body !== undefined) rm.setRequestBody(JSON.stringify(body));

            var resp = rm.execute();
            var status = resp.getStatusCode();
            var text = resp.getBody();
            var parsed = text;
            try { parsed = text ? JSON.parse(text) : null; } catch (ignore) { /* non-JSON body */ }
            var retryAfter = parseInt(resp.getHeader('Retry-After'), 10);

            return {
                ok: status >= 200 && status < 300,
                status: status,
                body: parsed,
                error: resp.haveError() ? resp.getErrorMessage() : null,
                retryAfterMs: isNaN(retryAfter) ? null : retryAfter * 1000
            };
        } catch (e) {
            return { ok: false, status: 0, body: null, error: 'Transport error: ' + e.message, transport: true };
        }
    },

    _isRetryable: function (r) {
        return r.transport === true || r.status === 0 || this.retryableStatus.indexOf(r.status) > -1;
    },

    /** Exponential backoff with a ceiling; honours Retry-After when the server sends it. */
    _backoff: function (attempt, retryAfterMs) {
        if (retryAfterMs) return Math.min(retryAfterMs, 60000);
        return Math.min(this.baseDelayMs * Math.pow(2, attempt - 1), 30000);
    },

    _queryString: function (query) {
        if (!query) return '';
        var parts = [];
        for (var k in query) {
            if (query.hasOwnProperty(k) && query[k] !== undefined && query[k] !== null) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
            }
        }
        return parts.length ? '?' + parts.join('&') : '';
    },

    /** Recursively masks values whose keys look sensitive before anything is logged. */
    mask: function (obj) {
        var sensitive = /pass(word)?|secret|token|api[_-]?key|authorization|ssn|credential/i;
        if (obj === null || typeof obj !== 'object') return obj;
        var out = Array.isArray(obj) ? [] : {};
        for (var k in obj) {
            if (!obj.hasOwnProperty(k)) continue;
            out[k] = sensitive.test(k) ? '****' : this.mask(obj[k]);
        }
        return out;
    },

    _log: function (method, url, body, result) {
        try {
            var gr = new GlideRecord(this.logTable);
            gr.initialize();
            gr.setValue('u_integration', this.integrationName);
            gr.setValue('u_method', method);
            gr.setValue('u_url', url.replace(/([?&](token|key|api_key)=)[^&]*/gi, '$1****'));
            gr.setValue('u_request', body ? JSON.stringify(this.mask(body)).substring(0, 4000) : '');
            gr.setValue('u_status', result.status);
            gr.setValue('u_attempts', result.attempts);
            gr.setValue('u_success', result.ok);
            gr.setValue('u_correlation_id', result.correlationId);
            gr.setValue('u_error', result.error || '');
            gr.insert();
        } catch (e) {
            gs.error('ResilientRestClient: failed to write integration log: {0}', e.message);
        }
        if (!result.ok) {
            gs.warn('ResilientRestClient [{0}] {1} {2} failed after {3} attempt(s): {4}',
                this.integrationName, method, url, result.attempts, result.error);
        }
    },

    type: 'ResilientRestClient'
};
