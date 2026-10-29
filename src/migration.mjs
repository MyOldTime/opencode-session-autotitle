import { LEGACY_PLUGIN_ID, LEGACY_SESSION_KEY, LegacyStateRpc } from '../migration/rpc.mjs';

export const MIGRATION_KEY = 'meta/migrated-from-local-v1';
// All locations share a plugin's host storage. Serialize startup migrations in
// this process so another instance cannot overwrite a newly unlocked record.
let migrationQueue = Promise.resolve();

export function migrateLegacyState(ctx) {
  const run = migrationQueue.catch(() => {}).then(() => migrate(ctx));
  migrationQueue = run.catch(() => {});
  return run;
}

async function migrate(ctx) {
  const completed = await ctx.storage.get(MIGRATION_KEY);
  if (completed?.schema === 1 && completed.source === LEGACY_PLUGIN_ID) return completed;
  const source = ctx.rpc(LegacyStateRpc);
  let after, copied = 0, preserved = 0;
  for (;;) {
    let page;
    try { page = await source.read(after ? {after} : {}); }
    catch { throw new Error('旧版状态迁移未完成：请先加载 migration 桥接包，再加载新版插件。'); }
    if (!Array.isArray(page.entries) || page.entries.length > 100) throw new Error('Invalid legacy state page');
    let previous = after ?? '';
    for (const {key, value} of page.entries) {
      if (!LEGACY_SESSION_KEY.test(key) || key <= previous || value?.schema !== 1
          || !['auto', 'locked'].includes(value.mode) || typeof value.baselineTitle !== 'string'
          || !Array.isArray(value.tasks)) throw new Error('Invalid legacy session state');
      previous = key;
    }
    if (page.next !== undefined && (!page.entries.length || page.next !== previous)) {
      throw new Error('Invalid legacy state cursor');
    }
    if (after === undefined && typeof page.installedAt === 'number' && Number.isFinite(page.installedAt)
        && await ctx.storage.get('meta/installed-at') === undefined) {
      await ctx.storage.set('meta/installed-at', page.installedAt);
    }
    for (const {key, value} of page.entries) {
      // A resumable copy never replaces an existing new-namespace decision.
      if (await ctx.storage.get(key) !== undefined) { preserved++; continue; }
      await ctx.storage.set(key, structuredClone(value));
      copied++;
    }
    if (!page.next) break;
    after = page.next;
  }
  const result = {schema: 1, source: LEGACY_PLUGIN_ID, copied, preserved, completedAt: Date.now()};
  await ctx.storage.set(MIGRATION_KEY, result);
  return result;
}
