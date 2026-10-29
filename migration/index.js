import { LEGACY_PLUGIN_ID, LEGACY_SESSION_KEY, LegacyStateRpc } from './rpc.mjs';

// Temporary upgrade bridge: the old ID grants access to its own host storage.
// It registers only a read-only RPC, never naming hooks, tools or commands.
export default {
  id: LEGACY_PLUGIN_ID,
  async setup(ctx) {
    const registration = await ctx.rpc.register(LegacyStateRpc, {
      read: async ({after}) => {
        if (after !== undefined && !LEGACY_SESSION_KEY.test(after)) throw new Error('Invalid migration cursor');
        const page = await ctx.storage.scan({prefix: 'sessions/', limit: 100, ...(after ? {after} : {})});
        const installedAt = after === undefined ? await ctx.storage.get('meta/installed-at') : undefined;
        return {...page, ...(typeof installedAt === 'number' && Number.isFinite(installedAt) ? {installedAt} : {})};
      },
    });
    return () => registration.dispose();
  },
};
