import test from 'node:test';
import assert from 'node:assert/strict';
import bridge from '../migration/index.js';
import server from '../index.js';
import {LegacyStateRpc, LEGACY_PLUGIN_ID} from '../migration/rpc.mjs';
import {migrateLegacyState, MIGRATION_KEY} from '../src/migration.mjs';

const key = n => `sessions/ses_${String(n).padStart(4, '0')}`;
const state = n => ({schema: 1, mode: 'locked', reason: n % 2 ? 'external_rename' : 'explicit_lock',
  baselineTitle: `[对象](修复)任务${n}`, tasks: [{id: 't1', subject: '对象', verb: '修复', target: `任务${n}`}],
  anchor: {text: '原始需求'}, initialNamed: true, pending: null, lastAttemptAt: n,
  model: {providerID: 'opencode', id: 'big-pickle'}, generationAttempts: 1, lastOutcome: 'locked'});
function storage(map) {
  return {
    get: async k => structuredClone(map.get(k)),
    set: async (k, v) => {map.set(k, structuredClone(v));},
    scan: async ({prefix, after, limit}) => {
      const rows = [...map].filter(([k]) => k.startsWith(prefix) && (!after || k > after)).sort(([a], [b]) => a.localeCompare(b));
      const entries = rows.slice(0, limit).map(([key, value]) => ({key, value: structuredClone(value)}));
      return {entries, ...(rows.length > limit ? {next: entries.at(-1).key} : {})};
    },
  };
}
async function harness(count = 205, existing = new Map()) {
  const old = new Map([['meta/installed-at', 123], ...Array.from({length: count}, (_, n) => [key(n), state(n)])]);
  let handlers, disposed = false, reads = 0;
  const cleanup = await bridge.setup({storage: storage(old), rpc: {register: async (definition, impl) => {
    assert.equal(definition, LegacyStateRpc);handlers = impl;return {dispose: async () => {disposed = true;}};
  }}});
  const ctx = {storage: storage(existing), rpc: definition => {
    assert.equal(definition, LegacyStateRpc);return {read: input => {reads++;return handlers.read(input);}};
  }};
  return {old, existing, ctx, handlers, cleanup, get reads() {return reads;}, get disposed() {return disposed;}};
}

test('bridge exposes only paged read access to its legacy host namespace', async () => {
  const h = await harness(101);const before = structuredClone(h.old);
  assert.equal(bridge.id, LEGACY_PLUGIN_ID);
  const page = await h.handlers.read({});assert.equal(page.entries.length, 100);assert.equal(page.installedAt, 123);
  const next = await h.handlers.read({after: page.next});assert.equal(next.entries.length, 1);assert.equal(next.installedAt, undefined);
  for (const after of ['', 'meta/installed-at', '../other', 'sessions/not-a-session']) {
    await assert.rejects(h.handlers.read({after}), /Invalid migration cursor/);
  }
  assert.deepEqual(h.old, before);await h.cleanup();assert.equal(h.disposed, true);
});

test('migration preserves locks, task ledger, model and timestamps across more than one page', async () => {
  const h = await harness();const before = structuredClone(h.old);
  const result = await migrateLegacyState(h.ctx);assert.equal(result.copied, 205);assert.equal(h.reads, 3);
  for (const [k, v] of h.old) assert.deepEqual(h.existing.get(k), v);
  assert.deepEqual(h.old, before);assert.equal(h.existing.get(MIGRATION_KEY).source, LEGACY_PLUGIN_ID);
});

test('existing new-namespace decisions win and a completed migration never resurrects old locks', async () => {
  const newer = {...state(0), mode: 'auto', reason: 'explicit_unlock', lastOutcome: 'unlocked'};
  const h = await harness(2, new Map([[key(0), newer], ['meta/installed-at', 456]]));
  const first = await migrateLegacyState(h.ctx);assert.equal(first.preserved, 1);assert.equal(first.copied, 1);
  assert.deepEqual(h.existing.get(key(0)), newer);assert.equal(h.existing.get('meta/installed-at'), 456);
  h.existing.delete(key(1));h.ctx.rpc = () => {throw new Error('removed bridge');};
  assert.deepEqual(await migrateLegacyState(h.ctx), first);assert.equal(h.existing.has(key(1)), false);
});

test('failed copying is resumable without changing legacy data or overwriting a newer target', async () => {
  const h = await harness(3), before = structuredClone(h.old), set = h.ctx.storage.set;
  h.ctx.storage.set = async (k, value) => {if (k === key(1)) throw new Error('storage unavailable');return set(k, value);};
  await assert.rejects(migrateLegacyState(h.ctx), /storage unavailable/);assert.equal(h.existing.has(MIGRATION_KEY), false);
  const newer = {...state(0), mode: 'auto'};h.existing.set(key(0), newer);h.ctx.storage.set = set;
  const result = await migrateLegacyState(h.ctx);assert.equal(result.copied, 2);assert.equal(result.preserved, 1);
  assert.deepEqual(h.existing.get(key(0)), newer);assert.deepEqual(h.old, before);
});

test('required unavailable migration fails setup before hooks, commands or tools can run', async () => {
  let writes = 0;
  const ctx = {options: {migrateLegacyState: true}, location: {directory: process.cwd()},
    storage: {get: async () => undefined, set: async () => {writes++;}},
    rpc: () => ({read: async () => {throw new Error('rpc.unavailable');}}),
    session: {hook: async () => {throw new Error('must not register');}},
  };
  await assert.rejects(server.setup(ctx), /请先加载 migration 桥接包/);assert.equal(writes, 0);
});

test('concurrent location startups share a single complete migration', async () => {
  const h = await harness(3);
  const [first, second] = await Promise.all([migrateLegacyState(h.ctx), migrateLegacyState(h.ctx)]);
  assert.deepEqual(first, second);assert.equal(h.reads, 1);assert.equal(first.copied, 3);
});

test('invalid legacy rows and non-advancing cursors cannot mark a partial migration complete', async () => {
  for (const page of [
    {entries: [{key: 'other/plugin', value: state(1)}]},
    {entries: [{key: key(1), value: {schema: 1}}]},
    {entries: [{key: key(2), value: state(2)}, {key: key(1), value: state(1)}]},
    {entries: [{key: key(1), value: state(1)}], next: key(0)},
    {entries: [], next: key(0)},
  ]) {
    const map = new Map();const ctx = {storage: storage(map), rpc: () => ({read: async () => page})};
    await assert.rejects(migrateLegacyState(ctx), /Invalid legacy/);assert.equal(map.size, 0);
  }
});
