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

## 真实服务测试（主动选择）

先安装本插件，确保 OpenCode 2.2.0 服务可访问并已配置模型。在仓库根目录运行：

```sh
node scripts/status-smoke.mjs
node scripts/live-smoke.mjs
node scripts/model-smoke.mjs provider/model#variant
```

- `status-smoke` 不调用模型，验证真实 RPC、只读性及实际终端命令处理器。它捕获弹窗调用，不代替终端画面/按键验收。
- `live-smoke` 创建带测试标记的隔离会话，测试安装版命名与生命周期，并在结束时删除这些会话；会消耗模型额度。使用宿主默认模型，或通过环境变量 `AUTOTITLE_SMOKE_MODEL=provider/model#variant` 指定模型。
- `model-smoke` 只发送脚本中的合成样例，可额外指定第三个参数为某个样例名。`OPENCODE_BIN` 可覆盖 OpenCode CLI 路径。
- `AUTOTITLE_SMOKE_DIRECTORY` 可为服务测试指定隔离目录；默认使用系统临时目录。

`v0.1.5` 发布前已通过 18 项真实服务检查和 6 项只读状态检查，9 个隔离会话均已清理。失败重试场景使用不存在的供应商经过实际宿主生成接口，确认三次尝试及约三秒退避；超时和迟到响应使用受控自动化测试验证，未逐一验收所有供应商。

运行结果写入被 Git 忽略的 `artifacts/`，不随 npm 包发布。
