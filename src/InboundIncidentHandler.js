/**
 * Script Include: InboundIncidentHandler
 *
 * Business logic for a Scripted REST API resource (POST /api/x_portfolio/v1/incidents)
 * that lets a monitoring or partner system raise incidents. The Scripted REST resource
 * stays thin and delegates here, which keeps the logic unit-testable:
 *
 *   (function process(request, response) {
 *       var result = new InboundIncidentHandler().process(request.body.data);
 *       response.setStatus(result.status);
 *       response.setBody(result.body);
 *   })(request, response);
 *
 * Features: payload validation, idempotency on the caller's external id, value mapping
 * (severity -> impact/urgency), CI lookup by name, and consistent error responses.
 *
 * Portfolio project: written independently with synthetic data. Not client code.
 */
var InboundIncidentHandler = Class.create();
InboundIncidentHandler.prototype = {

    initialize: function (opts) {
        opts = opts || {};
        this.table = opts.table || 'incident';
        this.externalRefField = opts.externalRefField || 'correlation_id';
        this.defaultGroup = opts.defaultGroup || gs.getProperty('x_portfolio.inbound.default_group', '');
        // severity from the source system -> [impact, urgency]
        this.severityMap = opts.severityMap || {
            critical: ['1', '1'],
            major: ['2', '1'],
            minor: ['2', '2'],
            warning: ['3', '3'],
            info: ['3', '3']
        };
    },

    /**
     * @param {Object} payload  { external_id, summary, description?, severity, ci_name?, caller? }
     * @returns {{status:number, body:Object}}
     */
    process: function (payload) {
        var errors = this.validate(payload);
        if (errors.length) {
            return { status: 400, body: { result: 'error', errors: errors } };
        }

        try {
            var existing = new GlideRecord(this.table);
            existing.addQuery(this.externalRefField, payload.external_id);
            existing.addQuery('state', '!=', '7'); // ignore closed incidents
            existing.setLimit(1);
            existing.query();

            if (existing.next()) {
                // Idempotent: the same alert re-sent updates work notes instead of creating a duplicate
                existing.setValue('work_notes', 'Repeat event received from source: ' + payload.summary);
                existing.update();
                return {
                    status: 200,
                    body: { result: 'updated', number: existing.getValue('number'), sys_id: existing.getUniqueValue() }
                };
            }

            var map = this.severityMap[String(payload.severity).toLowerCase()];
            var inc = new GlideRecord(this.table);
            inc.initialize();
            inc.setValue('short_description', String(payload.summary).substring(0, 160));
            inc.setValue('description', payload.description || payload.summary);
            inc.setValue('impact', map[0]);
            inc.setValue('urgency', map[1]);
            inc.setValue(this.externalRefField, payload.external_id);
            inc.setValue('contact_type', 'integration');

            var ciId = payload.ci_name ? this._findCI(payload.ci_name) : null;
            if (ciId) inc.setValue('cmdb_ci', ciId);
            if (this.defaultGroup) inc.setValue('assignment_group', this.defaultGroup);

            var sysId = inc.insert();
            return {
                status: 201,
                body: { result: 'created', number: inc.getValue('number'), sys_id: sysId, ci_matched: !!ciId }
            };
        } catch (e) {
            gs.error('InboundIncidentHandler: {0}', e.message);
            return { status: 500, body: { result: 'error', errors: ['Internal error; see system log'] } };
        }
    },

    /** @returns {string[]} list of validation messages (empty when valid) */
    validate: function (p) {
        var errors = [];
        if (!p || typeof p !== 'object') return ['Request body must be a JSON object'];
        if (!p.external_id || !/^[A-Za-z0-9._:-]{1,100}$/.test(p.external_id)) {
            errors.push('external_id is required (1-100 chars: letters, digits, . _ : -)');
        }
        if (!p.summary || String(p.summary).trim().length < 5) errors.push('summary is required (min 5 chars)');
        if (!p.severity || !this.severityMap[String(p.severity).toLowerCase()]) {
            errors.push('severity must be one of: ' + Object.keys(this.severityMap).join(', '));
        }
        return errors;
    },

    _findCI: function (name) {
        var ci = new GlideRecord('cmdb_ci');
        ci.addQuery('name', name);
        ci.addQuery('operational_status', '1');
        ci.setLimit(1);
        ci.query();
        return ci.next() ? ci.getUniqueValue() : null;
    },

    type: 'InboundIncidentHandler'
};
