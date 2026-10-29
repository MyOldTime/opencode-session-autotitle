import { AutoTitleController, PLUGIN_ID } from './src/controller.mjs';
import { AutoTitleStatusRpc } from './src/status-rpc.mjs';
import { formatStatus } from './src/status-display.mjs';

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const controller = new AutoTitleController(ctx);
    try {
      await controller.start();
      controller.registrations.push(await ctx.rpc.register(AutoTitleStatusRpc, {
        read: async ({sessionID}) => {
          // Host JSON-schema validation disables regex patterns in 2.2.0.
          if (typeof sessionID !== 'string' || !/^ses_[A-Za-z0-9_-]{1,124}$/.test(sessionID)) {
            throw new Error('无效的会话 ID');
          }
          const status = await controller.status(sessionID);
          return {sessionID, status, message: formatStatus(status, {sessionID, timeoutMs: controller.options.timeoutMs})};
        },
      }));
      return () => controller.dispose();
    } catch (error) {
      await controller.dispose();
      throw error;
    }
  },
};
