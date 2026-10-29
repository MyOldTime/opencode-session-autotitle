const OUTCOMES = {
  not_evaluated: '尚未评估', renamed: '已更新标题', keep: '保持原标题', defer: '信息不足，暂缓命名',
  generating: '正在生成候选标题', cancelled_or_timeout: '生成被取消或超时', model_failed: '模型请求失败',
  generation_timeout: '模型请求超时', retry_wait: '生成失败，等待重试', cancelled: '生成已取消',
  failed: '生成失败（历史通用结果）', evaluation_failed: '评估发生异常',
  locked: '标题已锁定', unlocked: '已解锁，等待后续评估', no_context: '没有可用于命名的上下文',
  prompt_budget_exceeded: '命名上下文超过输入预算', unchanged: '输入未变化',
  stale: '评估期间上下文变化，已丢弃候选', model_changed: '评估期间模型变化，已丢弃候选',
  external_rename: '检测到外部改名', busy: '会话正在执行', cooldown: '仍在冷却期',
  below_threshold: '新增用户轮数未达到门槛', initial_only: '仅初始命名模式',
  out_of_scope: '不在自动命名范围', ineligible: '会话不适用', pending_write: '等待标题写入确认',
  pending_native: '等待宿主写入初始标题', write_uncertain: '标题写入结果尚未确认', closed: '插件已关闭',
};
const REASONS = {
  default_unlocked: '默认未锁定', explicit_lock: '通过命令锁定', external_rename: '人工或其他插件改名',
  out_of_scope: '不在自动命名范围', fork_not_adopted: '尚未接管分叉会话',
};
const FAILURES = {
  model_failed: '模型请求失败', generation_timeout: '模型请求超时',
};
// Untrusted model/provider IDs and old reason codes must not inject terminal
// escapes, bidi controls or extra lines into a client-side status dialog.
const text = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').slice(0, 180);
function describe(code, dictionary) {
  const safe = text(code || 'unknown');
  if (Object.hasOwn(dictionary, code)) return `${dictionary[code]} (${safe})`;
  if (typeof code === 'string' && code.startsWith('invalid_')) return `模型输出未通过校验 (${safe})`;
  return `未识别状态 (${safe})`;
}

export function formatStatus(status, {sessionID, timeoutMs}) {
  const ref = status.lastModel;
  const model = ref ? `${text(ref.providerID)}/${text(ref.id)}${ref.variant ? ` #${text(ref.variant)}` : ''}` : '尚无记录';
  const timestamp = Number(status.lastAttemptAt);
  const date = timestamp > 0 ? new Date(timestamp) : null;
  const time = date && Number.isFinite(date.getTime()) ? date.toISOString() : '尚无记录';
  const attempts = Number(status.generationAttempts);
  const maxAttempts = Number(status.generationMaxAttempts);
  const generation = Number.isFinite(attempts) && attempts >= 0 && Number.isFinite(maxAttempts) && maxAttempts > 0
    ? `${Math.min(attempts, maxAttempts)}/${maxAttempts}` : '尚无记录';
  const failure = status.lastGenerationFailure
    ? `；最近生成失败：${describe(status.lastGenerationFailure, FAILURES)}` : '';
  return [
    `会话：${text(sessionID)}`,
    `自动命名范围：${status.managed ? '适用' : '不适用'}；已有记录：${status.tracked ? '是' : '否'}`,
    `标题锁定：${status.locked ? '是' : '否'}；模式：${text(status.mode)}`,
    `原因：${describe(status.reason, REASONS)}`,
    `最近结果：${describe(status.lastOutcome, OUTCOMES)}`,
    `本轮生成尝试：${generation}${failure}`,
    `最近使用的命名模型：${model}`,
    `最近评估时间（UTC）：${time}`,
    `命名超时：${timeoutMs / 1000} 秒；保存任务：${status.taskCount ?? 0}；待确认写入：${status.pending ? '是' : '否'}`,
    '', '只读查询：不调用模型、不写入聊天、不改标题或锁定状态。',
  ].join('\n');
}
