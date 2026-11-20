'use strict';
/** Scriptable fake for sn_ws.RESTMessageV2. Queue responses; inspect sent requests. */
function createRestMock() {
  const queue = [];
  const sent = [];
  function RESTMessageV2() { this.req = { headers: {} }; }
  RESTMessageV2.prototype = {
    setHttpMethod(m) { this.req.method = m; },
    setEndpoint(u) { this.req.url = u; },
    setHttpTimeout(t) { this.req.timeout = t; },
    setRequestHeader(k, v) { this.req.headers[k] = v; },
    setRequestBody(b) { this.req.body = b; },
    setAuthenticationProfile(type, id) { this.req.auth = { type, id }; },
    execute() {
      sent.push(this.req);
      const next = queue.shift();
      if (!next) throw new Error('No mock response queued');
      if (next.throw) throw new Error(next.throw);
      return {
        getStatusCode: () => next.status,
        getBody: () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body || null)),
        getHeader: (h) => (next.headers || {})[h],
        haveError: () => next.status >= 400,
        getErrorMessage: () => 'HTTP ' + next.status,
      };
    },
  };
  return { sn_ws: { RESTMessageV2 }, queue, sent };
}
module.exports = { createRestMock };
