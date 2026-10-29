# v0.1.7：迁移到作者命名空间

| 标识 | v0.1.6 及更早版本 | v0.1.7 |
|---|---|---|
| 服务端插件 | `local.session-autotitle` | `myoldtime.session-autotitle` |
| TUI 插件 | `local.session-autotitle.tui` | `myoldtime.session-autotitle.tui` |
| 状态 RPC | `local.session-autotitle.status` | `myoldtime.session-autotitle.status` |
| TUI 命令 ID | `session-autotitle.status` | `myoldtime.session-autotitle.status` |

命令仍为 `/autotitle-status`、`/autotitle-lock`、`/autotitle-unlock`、`/autotitle-refresh`；模型工具名为 `autotitle_status`。RPC 调用方请重新导入新版包的 `./rpc` 契约；自定义终端快捷键、禁用规则、策略中引用的旧 ID 需改为新 ID。

## 为什么需要迁移

OpenCode 的 `ctx.storage` 按插件 ID 隔离，公开 API 不提供跨插件存储读取。直接换 ID 会让新版看不到旧版的锁、任务清单和命名进度。

本版本提供临时 `migration` 桥接包：它以旧 ID 读取旧存储，只注册分页读取 RPC；新版通过宿主 API 复制到新命名空间。迁移完成后删除桥接配置，日常加载列表只显示 `myoldtime.*`。底层数据库不需要人工修改。

## 升级步骤

1. 备份原配置。将原来的一条自动命名插件配置**替换**为下面两条，保留其他插件和原有 options。顺序为桥接在前、新版在后；不要同时保留旧版自动命名包。若旧版来自自动发现的 `plugins/` 目录，先将其移出该目录。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:MyOldTime/opencode-session-autotitle#v0.1.7::path:migration",
    {
      "package": "github:MyOldTime/opencode-session-autotitle#v0.1.7",
      "options": {
        "mode": "adaptive",
        "language": "zh-CN",
        "timeoutMs": 45000,
        "migrateLegacyState": true
      }
    }
  ]
}
```

示例 options 需与自己的原配置合并，只额外加入 `migrateLegacyState: true`。原本使用 GitHub Packages 的主插件也可继续使用 `@myoldtime/opencode-session-autotitle@0.1.7`，桥接使用上面的 Git 来源。

2. 保存后等待宿主完成包安装和热重载。用 `opencode plugin list` 确认新版 `myoldtime.session-autotitle` 为 active，再在原已锁定的会话查询 `/autotitle-status` 或 `autotitle_status`，核对锁定状态。
3. 删除 `::path:migration` 那一条和临时 `migrateLegacyState` 选项，保留新版主插件与原有 options。保存后即可完成升级。

如果之前通过 `-local.session-autotitle` 禁用了插件，将禁用规则改为 `-myoldtime.session-autotitle`；希望继续禁用时，可以先完成迁移再恢复该规则。

## 迁移行为

- 复制旧安装时间和全部 `sessions/` 记录，包括人工/命令锁、任务、需求锚点、模型诊断、命名进度和待确认写入；按每页 100 条读取。
- 新命名空间已有的记录优先，不覆盖更新后的锁或解锁决定；完成标记在全部复制成功后才写入。中断后可重复执行。
- 迁移本身不调用模型、不改标题、不写聊天、不删除旧命名空间。之后按正常恢复规则核对标题；加载或只读查询不会启动命名。
- 指定 `migrateLegacyState: true` 但桥接不可用时，新版拒绝启动自动命名，待桥接可用后重新加载。完成迁移后，即使该选项尚未移除，也不会重复导入。
- 旧存储保留作为升级来源；回退旧版本不会自动同步新版后来发生的锁定/解锁变化。

首次安装无需桥接或迁移选项。已经直接安装新版的用户也可补做上述迁移；新版已有的记录会优先保留。
