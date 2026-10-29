import { AutoTitleStatusRpc } from './src/status-rpc.mjs';
import { TUI_PLUGIN_ID, STATUS_RPC_ID } from './src/identity.mjs';

// Plugin.define is an identity helper in 2.2.0, just as for our server entry.
// No JSX/OpenTUI dependencies: use the host's supported alert dialog API.
export default {
  id: TUI_PLUGIN_ID,
  setup(context) {
    let disposed = false;
    let pending = false;
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [{
        id: STATUS_RPC_ID, title: '查看自动命名状态', group: '自动命名',
        palette: true, slash: {name: 'autotitle-status'},
        run: async () => {
          if (disposed || pending) return;
          const route = context.ui.router.current();
          if (route.type !== 'session') {
            context.ui.toast.show({message: '请先打开需要查询的会话。', variant: 'info'});
            return;
          }
          const sessionID = route.sessionID;
          const location = context.data.session.get(sessionID)?.location
            ?? context.location ?? context.data.location.default();
          const stillHere = () => {
            const current = context.ui.router.current();
            return !disposed && current.type === 'session' && current.sessionID === sessionID;
          };
          pending = true;
          try {
            const result = await context.client.rpc(AutoTitleStatusRpc).read({sessionID}, {
              location, signal: AbortSignal.timeout(10000),
            });
            if (stillHere()) await context.ui.dialog.alert({title: '自动命名状态（只读）', message: result.message});
          } catch {
            // Never surface raw transport errors (may contain private URLs).
            if (stillHere()) context.ui.toast.show({
              title: '无法读取自动命名状态',
              message: '请确认服务已连接，且该会话所在目录已加载 v0.1.7 或更新的自动命名插件。未修改会话。',
              variant: 'error', duration: 8000,
            });
          } finally { pending = false; }
        },
      }],
    }));
    // The host owns/removes the keymap layer on plugin unload.
    return () => { disposed = true; };
  },
};
