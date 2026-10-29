# 测试与验收

## 自动化测试

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

测试使用合成消息和受控请求桩，不需要联网模型或 GitHub 凭据。覆盖命名校验、旧格式迁移、多任务保留、锁/解锁、上下文与模型切换、重试次数、超时、取消竞态、迟到结果和只读 RPC/TUI 处理器。

`v0.1.5` 发布准备阶段：源码与本地安装副本均通过 123 项测试。真实服务验收以 OpenCode 2.2.0、Windows 和 Node.js 24 为基线；跨平台自动化结果以仓库 Actions 为准。

`v0.1.6`：135 项自动化测试通过，增加免费模型的宿主会话通道、显式覆盖临时会话、并发隔离及取消清理测试。

`v0.1.7`：142 项自动化测试通过。新增跨 ID 状态迁移测试，覆盖超过一页的记录、人工/命令锁和任务完整保留、新记录优先、中断恢复、并发启动、桥接不可用及非法游标；原有状态测试同时核验新的服务端/TUI/RPC 标识。

真实 OpenCode 2.2.0 验收通过：2 个合成锁定会话的完整存储及历史比对、迁移桥接移除后的重载、后续解锁不被旧锁覆盖、6 项只读状态检查，以及 Big Pickle 和授权 DeepSeek 的命名检查。临时测试会话均已清理。升级方法见[迁移说明](MIGRATING-0.1.7.md)。

## 真实服务测试（主动选择）

先安装本插件，确保 OpenCode 2.2.0 服务可访问并已配置模型。在仓库根目录运行：

```sh
node scripts/status-smoke.mjs
node scripts/live-smoke.mjs
node scripts/model-smoke.mjs provider/model#variant
node scripts/compatibility-smoke.mjs
node scripts/compatibility-smoke.mjs opencode/big-pickle#default
```

- `status-smoke` 不调用模型，验证真实 RPC、只读性及实际终端命令处理器。它捕获弹窗调用，不代替终端画面/按键验收。
- `live-smoke` 创建带测试标记的隔离会话，测试安装版命名与生命周期，并在结束时删除这些会话；会消耗模型额度。使用宿主默认模型，或通过环境变量 `AUTOTITLE_SMOKE_MODEL=provider/model#variant` 指定模型。
- `model-smoke` 只发送脚本中的合成样例，可额外指定第三个参数为某个样例名。它直接测试独立生成接口；免费模型的完整插件路径请用 `compatibility-smoke`。`OPENCODE_BIN` 可覆盖 OpenCode CLI 路径。
- `compatibility-smoke` 默认遍历当前目录可用的 OpenCode 免费模型，也可指定一个或多个 `provider/model#variant`。用宿主原生 Session ID 导入合成需求，经已安装插件刷新并检查标题、调用通道、模型保持、聊天只读和临时子会话清理。此接口不执行工具循环；不要通过禁用全部工具来隔离免费模型测试，否则会改变所需的宿主请求上下文。
- `AUTOTITLE_COMPAT_DIRECTORY` 指定兼容性测试目录，`AUTOTITLE_COMPAT_REPORT` 指定报告路径。测试配置中的显式模型覆盖时，用 `AUTOTITLE_COMPAT_OVERRIDE=provider/model#variant` 指定期望命名模型。
- `AUTOTITLE_SMOKE_DIRECTORY` 可为服务测试指定隔离目录；默认使用系统临时目录。

`v0.1.5` 发布前已通过 18 项真实服务检查和 6 项只读状态检查，9 个隔离会话均已清理。失败重试场景使用不存在的供应商经过实际宿主生成接口，确认三次尝试及约三秒退避；超时和迟到响应使用受控自动化测试验证，未逐一验收所有供应商。

### v0.1.6 兼容性实测（2026-10-29，OpenCode 2.2.0）

合成需求为“操作日志默认按 createTime 倒序排序”。以下 7 款免费模型均通过标题校验，聊天历史保持不变：

| 模型 | variant | 单次实测耗时约 |
|---|---|---|
| `opencode/big-pickle` | default | 4 秒 |
| `opencode/deepseek-v4.1-flash-free` | low | 4 秒 |
| `opencode/nemotron-3.5-super-vl-free` | low | 14 秒 |
| `opencode/beam-free` | low | 4 秒 |
| `opencode/mimo-v2.6-flash-free` | default | 7 秒 |
| `opencode/glm-5.3-flash-free` | low | 3 秒 |
| `opencode/nemotron-3.5-lightning-free` | default | 65 秒，验收 `timeoutMs=90000` |

`opencode/flint-40b-free#low` 在该命名样例上 45 秒及 90 秒均超时；保持原标题，不将其列为成功。需要较长推理时间的模型可提高 `timeoutMs`，默认配置不保证在 45 秒内完成所有模型。

授权模型 `deepseek/deepseek-flash#default` 的独立通道约 4 秒通过；当前会话用 DeepSeek、插件显式覆盖为 Big Pickle 的临时子会话路径也通过，并确认子会话已删除、用户会话模型不变。Big Pickle 原生初始自动命名、6 项只读状态检查通过，所有测试会话均已清理。

运行结果写入被 Git 忽略的 `artifacts/`，不随 npm 包发布。
