// This small directory is also installable with Git's ::path:migration selector.
export const LEGACY_PLUGIN_ID = 'local.session-autotitle';
export const LEGACY_SESSION_KEY = /^sessions\/ses_[A-Za-z0-9_-]{1,124}$/;
export const LegacyStateRpc = {
  id: 'myoldtime.session-autotitle.legacy-state',
  events: {},
  methods: {
    read: {
      errors: {},
      input: {type: 'object', properties: {after: {type: 'string'}}, additionalProperties: false},
      output: {type: 'object', properties: {
        entries: {type: 'array', items: {type: 'object', properties: {
          key: {type: 'string'}, value: {},
        }, required: ['key', 'value'], additionalProperties: false}},
        next: {type: 'string'}, installedAt: {type: 'number'},
      }, required: ['entries'], additionalProperties: false},
    },
  },
};
