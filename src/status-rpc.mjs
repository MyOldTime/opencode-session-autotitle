// Structural RPC definition. In OpenCode 2.2.0 Rpc.define returns this object
// unchanged (verified in @opencode/schema/rpc); no runtime dependency is needed.
export const AutoTitleStatusRpc = {
  id: 'local.session-autotitle.status',
  events: {},
  methods: {
    read: {
      errors: {},
      input: {
        type: 'object', properties: {sessionID: {type: 'string', minLength: 5, maxLength: 128}},
        required: ['sessionID'], additionalProperties: false,
      },
      output: {
        type: 'object', properties: {
          sessionID: {type: 'string'}, status: {type: 'object'}, message: {type: 'string'},
        },
        required: ['sessionID', 'status', 'message'], additionalProperties: false,
      },
    },
  },
};
