// Explicit opt-in smoke test. Sends only the synthetic examples below; no user
// history/config credentials are read. Uses the CLI's own authenticated client.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildNamingPrompt, parseNamingResult, normalizeLedger, renderTitle, isCurrentTitleFormat, displayWidth } from '../src/naming.mjs';

const windowsBin = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm/node_modules/@opencode/cli/bin/opencode.exe') : null;
const bin = process.env.OPENCODE_BIN ?? (windowsBin && fs.existsSync(windowsBin) ? windowsBin : 'opencode');
const rawModel = process.argv[2];
const model = rawModel ? (() => {
  assert.match(rawModel, /^[^/#]+\/[^/#]+(?:#[^/#]+)?$/, 'model must be provider/model#variant');
  const [ref, variant] = rawModel.split('#');
  const split = ref.indexOf('/');
  return {providerID: ref.slice(0, split), id: ref.slice(split + 1), ...(variant ? {variant} : {})};
})() : undefined;
const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const caseName = process.argv[3];
if (caseName) assert.match(caseName, /^[a-z_]+$/, 'case name must be one of the synthetic case keys');
const reportPath = `artifacts/model-smoke-v${version}${caseName ? `-${caseName}` : ''}.json`;
const initial = text => ({messages: [{id: 'u1', role: 'user', text}], mode: 'initial'});
const sorted = {id: 't1', subject: '操作日志', verb: '修改', target: '按排序字段createTime倒序排序', state: 'done'};
const includes = (text, patterns) => { for (const pattern of patterns) assert.match(text, pattern); };
const cases = [
  {name: 'specific_sort', input: initial('请修改操作日志的默认排序：按排序字段createTime倒序排序。'), verify(result) {
    assert.equal(result.tasks.length, 1);
    includes(result.title, [/操作日志/, /createTime/, /倒序|降序/]);
  }},
  {name: 'shared_object_tasks', input: initial('操作日志有两个独立需求，都要保留：修改默认排序为按createTime倒序；补充清空筛选后回到第1页的交互。'), verify(result) {
    assert.equal(result.tasks.length, 2);
    assert.equal(new Set(result.tasks.map(t => t.subject)).size, 1);
    includes(result.title, [/createTime/, /倒序|降序/, /清空筛选/, /第?1页|首页|第一页/, /;\(/]);
    assert.equal(result.title.includes(' | '), false);
  }},
  {name: 'independent_tasks', input: initial('两个独立任务都要保留：操作日志按createTime倒序排序；登录接口收到401后刷新Token并重试原请求。'), verify(result) {
    assert.equal(new Set(result.tasks.map(t => t.subject)).size, 2);
    includes(result.title, [/操作日志/, /createTime/, /倒序|降序/, /登录接口/, /401/, /Token/, /重试/, / \| /]);
  }},
  {name: 'completed_task_retained', input: {
    messages: [
      {id: 'u1', role: 'user', text: '操作日志按排序字段createTime倒序排序。'},
      {id: 'a1', role: 'assistant', text: '第一项已完成。'},
      {id: 'u2', role: 'user', text: '另外一个独立任务：Redis连接超时只在空闲5分钟后发生，请排查。第一项完成也不要从标题删除。'},
    ], currentTitle: '操作日志｜修改按排序字段createTime倒序排序', tasks: [sorted], mode: 'adaptive',
  }, verify(result) {
    assert.deepEqual(result.tasks.find(t => t.id === 't1'), sorted);
    assert.equal(new Set(result.tasks.map(t => t.subject)).size, 2);
    includes(result.title, [/createTime/, /倒序/, /Redis/, /连接超时/, /空闲/, /5分钟/]);
  }},
  {name: 'readable_conditions', input: initial('请修复登录接口：收到401后只刷新一次Token并重试原请求，重试必须保留原请求参数；若刷新失败则跳转登录页，403不重试。这是一项修复，所有条件都很重要。'), verify(result) {
    assert.equal(result.tasks.length, 1);
    includes(result.title, [/401/, /Token/, /一次|1次|单次/, /重试/, /原.*参数/, /刷新失败|刷新.*失败/, /跳转.*登录|转.*登录页/, /403.*不重试|不重试403|排除403|跳过403/]);
  }},
  {name: 'technical_array_call', input: initial('请修复事件分发中调用handlers[0](event)时参数丢失的问题，保留这个准确的函数调用表达式。'), verify(result) {
    includes(result.title, [/handlers\[0\]\(event\)/, /参数丢失/]);
  }},
  {name: 'active_to_done_with_new_task', input: {
    messages: [
      {id: 'u1', role: 'user', text: '请修改操作日志：按排序字段createTime倒序排序。'},
      {id: 'u2', role: 'user', text: '第一项操作日志排序已完成。另一个独立任务：修复登录接口收到401后刷新Token并重试原请求。两个任务都要保留在标题中。'},
      {id: 'a1', role: 'assistant', text: '收到第二项任务。'},
    ], currentTitle: '[操作日志](修改)按排序字段createTime倒序排序', tasks: [{...sorted, state: 'active'}], mode: 'adaptive',
  }, verify(result) {
    assert.deepEqual(result.tasks.find(t => t.id === 't1'), sorted);
    assert.equal(new Set(result.tasks.map(t => t.subject)).size, 2);
    const second = result.tasks.find(t => t.id !== 't1');
    assert.equal(second?.state, 'active');
    includes(result.title, [/createTime/, /倒序/, /登录接口/, /401/, /Token/, /重试/]);
  }},
];
const selectedCases = caseName ? cases.filter(item => item.name === caseName) : cases;
assert.ok(selectedCases.length, `unknown case: ${caseName}`);
const report = [];
fs.mkdirSync('artifacts', {recursive: true});
for (const item of selectedCases) {
  const start = Date.now();
  const row = {name: item.name, model: model ?? 'host-default', ok: false};
  try {
    const built = buildNamingPrompt(item.input);
    row.estimatedInputTokens = built.estimatedTokens;
    const raw = execFileSync(bin, ['api', 'post', '/api/experimental/generate/text', '--data', JSON.stringify({prompt: built.prompt, ...(model ? {model} : {})})], {
      encoding: 'utf8', timeout: 65000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const response = JSON.parse(raw);
    const text = response.data?.text ?? response.text;
    const result = parseNamingResult(text, item.input.tasks ?? [], {currentTitle: item.input.currentTitle ?? ''});
    Object.assign(row, {title: result.title, tasks: result.tasks, errors: result.errors, rawText: text});
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.action, 'rename');
    assert.equal(isCurrentTitleFormat(result.title), true);
    assert.doesNotMatch(result.title, /[｜；［］（）]/);
    assert.equal(renderTitle(result.tasks), result.title);
    assert.deepEqual(normalizeLedger(result.tasks), result.tasks);
    const keep = parseNamingResult(JSON.stringify({action: 'keep', reasonCode: 'no_change'}), result.tasks, {currentTitle: result.title});
    assert.equal(keep.ok, true);
    assert.equal(keep.changed, false);
    assert.deepEqual(keep.tasks, result.tasks);
    item.verify(result);
    Object.assign(row, {ok: true, displayWidth: displayWidth(result.title)});
  } catch (error) {
    Object.assign(row, {error: error.code ?? error.name, message: (error.stderr?.toString().trim() || error.message).slice(0, 600)});
  }
  row.elapsedMs = Date.now() - start;
  report.push(row);
  console.log(JSON.stringify(row));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
const ok = report.length === selectedCases.length && report.every(r => r.ok);
console.log(JSON.stringify({ok, cases: report.length, reportPath}));
if (!ok) process.exitCode = 1;
