# OpenCode Session AutoTitle

[![CI](https://github.com/MyOldTime/opencode-session-autotitle/actions/workflows/ci.yml/badge.svg)](https://github.com/MyOldTime/opencode-session-autotitle/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@myoldtime/opencode-session-autotitle)](https://www.npmjs.com/package/@myoldtime/opencode-session-autotitle)
[![Release](https://img.shields.io/github/v/release/MyOldTime/opencode-session-autotitle)](https://github.com/MyOldTime/opencode-session-autotitle/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**根据对话需求，自动为 OpenCode 会话生成清晰、具体、可持续更新的中文标题。**

Adaptive Chinese session titles for OpenCode V2, with multi-task retention, persistent manual locks, read-only status and bounded generation retries.

插件 ID：`myoldtime.session-autotitle`；npm 包名：`@myoldtime/opencode-session-autotitle`，在 npmjs.org 与 GitHub Packages 同名发布。包含服务端和官方终端版 TUI 入口，无生产运行依赖。

标识采用作者的 GitHub/npm 命名空间：服务端 `myoldtime.session-autotitle`、终端 `myoldtime.session-autotitle.tui`、状态 RPC `myoldtime.session-autotitle.status`。模型可调用的只读工具名称为 `autotitle_status`。

## 功能

- **具体可读**：保留字段、排序方向、触发条件等关键细节，统一英文结构标点。
- **多任务保留**：最多展示两个主题对象；重要任务完成后仍留在标题中。
- **自适应更新**：初始命名、首次回复校准，以及后续达到门槛或切换主题时更新。
- **人工优先**：手动改名和 `/autotitle-lock` 共用持久锁，解锁不立即改名。
- **只读状态弹窗**：`/autotitle-status` 不调用模型、不增加聊天消息。
- **有界重试**：生成请求失败或超时后最多重试 2 次，可取消，迟到结果不提交。
- **模型跟随**：默认使用当前会话的模型与 variant，也支持插件单独指定模型。
- **免费模型适配**：根据宿主目录中的价格信息，自动为 OpenCode 免费模型使用会话瞬时生成通道。

## 环境要求

- **OpenCode V2**，已针对 **2.2.0** 验证。使用实验性生成接口，其他版本需自行验证兼容性。
- OpenCode 已配置可用的模型供应商。自动命名使用该供应商的额度。
- `/autotitle-status` 弹窗适用于官方终端版；其他客户端仍可使用服务端命名、锁命令与只读工具。
- 本地开发需要 Node.js **20.3+** 和 npm；推荐 Node.js 24。通过宿主安装插件无需构建步骤。

## 安装

**从 v0.1.6 或更早版本升级：** v0.1.7 更换了插件 ID。请按[旧版状态迁移](docs/MIGRATING-0.1.7.md)保留持久锁和任务记录；首次安装可直接使用下面的步骤。

### 方式一：从 npmjs.org 安装（推荐）

npmjs.org 上的公开包安装不需要登录 npm，也不需要提供 token。

```sh
opencode plugin add "@myoldtime/opencode-session-autotitle@0.1.7"
opencode plugin list
```

固定版本便于复现；安装后可在终端执行 `/reload`，进入会话并运行 `/autotitle-status` 查看状态。

如果希望仅对某项目生效，在该项目的 `opencode.json` 中配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@myoldtime/opencode-session-autotitle@0.1.7"]
}
```

`@myoldtime/opencode-session-autotitle@0.1.7` 在 npmjs.org 与 GitHub Packages 是同一个包名，实际下载来源由本机 npm 的 `@myoldtime:registry` 配置决定。若该 scope 曾被指向 GitHub Packages，请先按方式三末尾的命令切回 npmjs.org，再执行上述安装。

### 方式二：从 GitHub 标签安装

```sh
opencode plugin add "github:MyOldTime/opencode-session-autotitle#v0.1.7"
opencode plugin list
```

该方式直接读取 GitHub 仓库，不经过 npm registry，也不需要任何 token；固定 tag 同样便于复现。仅对某项目生效时，把项目 `opencode.json` 的 `plugins` 条目写成 `github:MyOldTime/opencode-session-autotitle#v0.1.7`。

### 方式三：从 GitHub Packages 安装

npmjs.org 与 GitHub Packages 是**两个独立 registry**，同一版本需要分别发布。根据 GitHub 的规则，即使包在 GitHub Packages 中是公有的，安装也需要使用具有 `read:packages` 权限的 **personal access token (classic)** 登录。

```sh
npm config set @myoldtime:registry https://npm.pkg.github.com --location=user
npm login --scope=@myoldtime --auth-type=legacy --registry=https://npm.pkg.github.com
# Username 输入 GitHub 用户名，Password 输入 token
opencode plugin add "@myoldtime/opencode-session-autotitle@0.1.7"
```

令牌交给 npm 登录保存，勿写入 `opencode.json` 或提交到仓库。若之后要改回 npmjs.org 安装，把该 scope 指回官方 registry（或删除 scope 覆盖，恢复默认）：

```sh
npm config set @myoldtime:registry https://registry.npmjs.org --location=user
```

不切回时，`@myoldtime/...` 的安装仍会路由到 GitHub Packages，容易出现 401/403/404。

### 本地开发安装

```sh
git clone https://github.com/MyOldTime/opencode-session-autotitle.git
cd opencode-session-autotitle
npm ci --ignore-scripts
```

在 OpenCode 配置中将 `package` 指向这个目录的绝对路径，例如 `/path/to/opencode-session-autotitle`；Windows JSON 中可用 `C:/path/to/opencode-session-autotitle`。插件本身无需编译。

**已有本地版本迁移**：先把旧的 `session-autotitle` 目录移出自动发现的 `~/.config/opencode/plugins/`，再按[旧版状态迁移](docs/MIGRATING-0.1.7.md)替换原配置项。

## 快速使用

1. 安装后正常开始会话，描述具体需求，插件会评估初始标题。
2. 想保留自己的命名，直接手动改名，或执行 `/autotitle-lock`。
3. 输入 `/autotitle-unlock` 恢复自动管理；需要立即评估时再执行 `/autotitle-refresh`。
4. 随时用 `/autotitle-status` 查看锁、最近结果、模型和尝试次数。

## 命名规则

- 单任务：`[操作日志](修改)按排序字段createTime倒序排序`
- 同对象双任务：`[操作日志](修改)按createTime倒序排序;(补充)清空筛选后回到第1页`
- 独立双任务：`[操作日志](修改)按createTime倒序排序 | [登录接口](修复)401后刷新Token并重试原请求`
- 结构标点全部英文：`[]();`，不同对象严格用 ` | `（两侧各一个空格）连接；同对象任务之间用 `;`，不重复对象名。
- 重要任务完成后仍保留；一个最终目标的步骤概括为主任务，不逐条拼接。
- 动作词由模型按真实意图自由生成，简短明确、同义保持；设计、科普、教学、讲解、部署只是非穷尽示例，不是固定词表。代码只校验结构、长度和安全边界，不限定具体用词。动作词默认不超过 16 显示列（汉字约 2 列），可用插件选项 `maxVerbWidth` 调整（2～32 列）。
- 任务描述用最少字数说清关键字段、方向、条件和行为，保留 `createTime`、倒序、401 后重试等区分性细节；不笼统写“优化功能/修改逻辑”，不编造细节，也不为长度牺牲可读性。
- 当前实现中文标题，保留技术原词大小写与 `sort()`、`handlers[0](event)` 等表达。默认软宽度 **80** 列仅作建议；硬宽度 **240** 列仅作异常保护，超限拒绝写入并保留原标题，不自动截断。汉字通常按 2 显示列计算，不是字符数。
- 最多两个主题对象；出现更多独立主题而无法合理概括时，保留原名，不悄悄丢弃既有重要任务。
- 模型输出结构化任务列表，由代码统一渲染标题。空泛输入由模型延后判断，非法结果保留原名。
- 旧 `对象｜动作任务` 格式在下一次正常评估或 `/autotitle-refresh` 时迁移；若旧标题与已存任务一致，即使模型返回 `keep` 也可只迁移格式。`defer`、无法确认的自由标题不强制迁移，锁定会话不写入，不扫描历史批量改名。

### 长度与重构边界

| 选项 | 默认显示列 | 可配置范围 | 行为 |
|---|---:|---:|---|
| `softTitleWidth` | 80 | 12～160 | 仅提示，不删除必要细节 |
| `hardTitleWidth` | 240 | 24～600 | 超出拒绝实际写入，包括旧格式迁移 |
| `maxSubjectWidth` | 64 | 4～120 | 新生成对象字段的上限 |
| `maxTargetWidth` | 160 | 8～300 | 新生成任务描述的上限 |
| `maxVerbWidth` | 16 | 2～32 | 新旧动作词共用的上限 |

用户显式配置优先于默认值。已保存的对象和描述不按宽度截断，超宽只警告；标题输出仍受硬限保护，输入仍受总 token 预算保护。无法无损简化时保留原标题，可按需调整插件选项。

采用局部重构：`src/title-format.mjs` 集中渲染、格式识别、去重和旧格式迁移；`src/naming.mjs` 负责提示、任务合并和安全校验。不重写 `controller.mjs` 的生命周期、人工锁、模型选择和调度，避免扩大回归范围。

## 生命周期

1. 普通主会话默认未锁定，已有名称不等于人工锁定。没有插件记录的旧会话在后续活动或 `/autotitle-refresh` 时按默认未锁定状态接管，无需先解锁；不会扫描并批量重命名历史会话。
2. 原生 `title` hook 生成初始候选；通过 `result` 让宿主落盘，观察实际写入后确认归属。
3. 一轮结束后防抖 **1.5 秒**，只在后台评估标题，不推迟主 Agent 回复。
4. 首次完整回复允许一次校准。之后新增至少 **4 轮有效用户输入**，或出现主题变化候选，才考虑评估；最终是否改名仍由命名模型判断。
5. 后续评估冷却 **60 秒**；冷却到期可合并处理一次。重复事件、同一内容指纹不会重复生成。
6. 新输入、锁定、归档、移动、删除、卸载会取消过期工作。支持热重载恢复，不需重启服务。
   命名请求失败或超时后最多追加重试 **2 次**（可配 `maxGenerationRetries`：0～2），即单次评估最多 **3 次请求**；每次尝试有独立的 `timeoutMs`，失败后分别等待约 1 秒、2 秒。重试前重新核对会话范围、锁定、标题、模型和上下文快照，任一变化即停止，不会用旧快照重发。请求成功但文本缺失/为空/非法、JSON 校验失败、keep/defer、读取/预算错误和标题写入失败都不重试，也不绕过校验。
7. 已压缩的会话会读取最近一份成功压缩摘要，结合近期需求、已有任务或短需求锚点命名。摘要单独标注为不可信历史素材，做脱敏并计入同一输入预算；不当作新增用户回合，不保存原始摘要。
8. 子会话、归档会话仍不在默认处理范围，继承标题的 fork 需明确接管；“不在范围”与“被锁定”是两回事。读取状态、解锁、重载本身均不触发命名。

## 命令

| 命令 | 行为 |
|---|---|
| `/autotitle-status` | **仅官方终端版**：只读弹窗显示托管范围、锁、最近结果/模型/时间、超时、本次生成尝试次数与失败原因；不调用模型、不写聊天、不改状态 |
| `/autotitle-lock` | 锁定当前名称，取消待执行的自动命名，持久保存 |
| `/autotitle-unlock` | 解除人工改名或锁定命令设置的同一个锁，以当前标题作为比较基准；不立即生成 |
| `/autotitle-refresh` | 主动评估一次，可绕过冷却；不绕过锁定、运行中检查或过期检查 |

命令不会向会话注入用户提示或 synthetic 消息。成功执行可能不产生聊天回复。
官方终端版在目标会话输入 `/autotitle-status`，或从命令面板选择“查看自动命名状态”，即可打开状态弹窗。它是本插件 `./tui` 部分注册的客户端命令，不向服务端提交聊天或生成请求。首页执行只提示先打开会话；切换会话时丢弃旧查询的弹窗。显示“最近使用的模型”，不声称它一定是下一次将选择的模型。

**OpenChamber 等第三方客户端暂不支持该弹窗命令**；也可让 Agent 调用只读工具 `autotitle_status`，查看是否托管、锁定原因、最近评估结果、任务数等。工具本身不改名，但让 Agent 调用的对话会正常进入聊天历史；希望完全不增加聊天时使用终端版命令。

状态查询由只读 RPC `myoldtime.session-autotitle.status.read({sessionID})` 提供，必须传会话所属 location。它不创建托管记录、不迁移内存状态、不解锁、不重置最近结果或调度。`retry_wait` 表示请求失败后等待重试，`model_failed` / `generation_timeout` 表示重试耗尽后的明确失败原因，`cancelled` 表示取消；历史记录仍可能显示 `cancelled_or_timeout`。`invalid_*` 表示输出校验失败；未知状态保留原码，不猜测原因。状态同时返回本次评估的 `generationAttempts` / `generationMaxAttempts` 和安全的 `lastGenerationFailure` 原因码（不保存错误文本、提示词或密钥）。

人工改名（包括只改标点）会被视为外部接管并自动锁定。由于公开事件没有可靠的操作者来源，其他插件改名也采用相同保护策略。
人工改名与 `/autotitle-lock` 共用 `sessions/<sessionID>` 记录里的 `mode: "locked"`，不存在第二把锁；两者都能由 `/autotitle-unlock` 解除。插件自己的标题提交不会锁定会话。
旧版本已记录的 `explicit_lock` / `external_rename` 锁会保留（可统一解锁）；不会猜测并批量清除可能由用户设置的锁。旧的 fork 范围排除记录不再伪装成锁。

状态工具会明确返回 `locked`、`mode`、是否适用 `managed`、是否已有记录 `tracked`、`lastOutcome` 和 `contextSources`。完全没有可用需求时，刷新返回明确的 `no_context` 提示；不再用笼统的 `skipped` 混淆锁定、冷却与上下文不足。

## 配置

全局配置位于 `~/.config/opencode/opencode.json`；Windows 通常为 `%USERPROFILE%/.config/opencode/opencode.json`。也可以配置在项目的 `opencode.json` 或 `.opencode/opencode.json`。相对插件目录以配置文件所在目录为基准。

将安装时的字符串条目改成下列带 `options` 的对象，而不是再追加一个相同插件条目：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@myoldtime/opencode-session-autotitle@0.1.7",
      "options": {
        "mode": "adaptive",
        "language": "zh-CN",
        "debounceMs": 1500,
        "cooldownMs": 60000,
        "minNewUserTurns": 4,
        "timeoutMs": 45000,
        "maxGenerationRetries": 2,
        "maxContextTokens": 2000,
        "manageSubsessions": false
      }
    }
  ]
}
```

这是需要合并的配置片段，**不要替换其他已有设置**。可复制 [完整示例](examples/opencode.example.jsonc)。配置更新后自动重载，也可在终端执行 `/reload`。
模型优先级：**插件显式配置 > 当前会话选定的模型（含 variant） > 当前 Agent 的模型 > OpenCode 当前默认模型**。
插件不固定模型，每次评估重新解析选择；重试复用同一快照并重新核对模型。切换会话模型会影响后续命名，不沿用旧缓存或原生辅助标题模型。
可选最高优先级覆盖示例：在此插件的 `options` 内添加 `"model": {"providerID":"openai","id":"gpt-6-astra","variant":"low"}`。删除该项或设为 `null` 即恢复跟随会话。
不另外读取或保存 API 密钥，不修改主 Agent 模型。代码的 `timeoutMs` 默认值为 **10000**，上例建议配置为 **45000**；所选模型更慢时可提高。默认允许两次重试时，生成与退避最坏等待约为 `3 × timeoutMs + 3 秒`，按上例约 **138 秒**（不含上下文读取与排队）。
`mode: "initial"` 只执行初始命名和首次校准；默认 `adaptive` 允许后续更新。

### 模型调用通道

授权、供应商协议、模型设置及 variant 均由 OpenCode 管理，插件不自行请求供应商 API。

- **OpenCode 免费模型**：查询 `ctx.model.list()` 中 `opencode` / `opencode-go` 模型的价格，所有输入/输出档位均为 0 时使用 `ctx.session.generate`。保留宿主生成的系统提示、工具定义、请求信息和授权；一次性关联的 `generate` 钩子只把消息替换为经过筛选的命名输入，不混入完整聊天历史。
- **其他模型**：使用 `ctx.experimental.generate.text` 独立生成。
- 免费命名模型与当前会话模型不同时，创建由宿主分配 ID 的空临时子会话，完成、失败或取消后清理。临时会话不会接管自动命名，主会话模型不变。
- 两条通道都不写入聊天消息。会话瞬时接口会携带宿主工具定义，但不执行工具循环；空文本或工具调用而无有效文本会被输出校验拒绝。

`/autotitle-status` 中的“调用通道”及 RPC 的 `lastGenerationRoute` 可用于确认实际路径。命名输入仍受 `maxContextTokens` 的估算预算限制；会话通道另外包含宿主的系统提示和工具定义，这部分由宿主管理，不计入插件输入预算。

### 常用选项

| 选项 | 代码默认值 | 说明 |
|---|---|---|
| `mode` | `"adaptive"` | `adaptive` / `initial` |
| `language` | `"zh-CN"` | 当前仅实现 `zh-*` 中文标题，技术词保留原文 |
| `model` | `null` | 跟随会话；覆盖格式为 `{providerID, id, variant?}` |
| `timeoutMs` | `10000` | 每次请求超时，250～300000 毫秒；推荐从 45000 开始 |
| `maxGenerationRetries` | `2` | 额外重试次数，0～2；总尝试不超过 3 次 |
| `debounceMs` | `1500` | 空闲事件防抖，0～60000 毫秒 |
| `cooldownMs` | `60000` | 后续评估冷却，0～3600000 毫秒 |
| `minNewUserTurns` | `4` | 普通后续更新门槛，1～50 个有效用户回合 |
| `manageSubsessions` | `false` | 是否接管子会话 |
| `migrateLegacyState` | `false` | 仅旧 ID 升级时临时启用，配合迁移桥接包；完成后可删除 |
| `maxContextTokens` | `2000` | 估算输入预算，200～200000 |
| `recentTurns` | `6` | 提取近期消息的窗口，1～20 |
| `maxTasks` | `8` | 持久任务数上限，1～24 |
| `maxDisplayFragments` | `2` | 标题片段数上限，1～2 |

宽度选项见上方“长度与重构边界”。高级预算参数 `charsPerToken` 默认 1.5（范围 0.5～8），`messageWidth` 默认 600（范围 40～8000）。`extendedTitleWidth` 自动推导为 `min(hardTitleWidth, softTitleWidth + 8)`。未知选项或类型错误会拒绝加载；合法数字按范围取整/限制，`charsPerToken` 保留小数。

## 持久化位置

使用宿主 `ctx.storage`，由插件 ID 隔离。记录键：`sessions/<sessionID>`。
保存托管模式、锁定原因、比较基准、任务摘要、去敏的短需求锚点、消息 ID/指纹、最近评估和待确认写入。
不保存完整聊天原文，不写 `AGENTS.md`，不在标题中插入锁定标签。
底层数据库路径由 OpenCode 管理，插件不直接读写其数据库。导出会话不保证携带插件存储。

## 安全与已知边界

- 命名使用上面的宿主生成通道，不执行工具循环、不写会话历史；模型调用消耗现有服务的额度。
- 输入使用用户及可见助手文本，以及最近一份已完成压缩摘要；不直接提取 reasoning、工具输出和系统消息。使用首个诉求与近期内容，约 2,000 tokens 的**估算**预算（不是模型 tokenizer 的精确计数）。
- 对常见密钥、Bearer、邮箱、手机号、绝对路径做特征脱敏；这不是万能隐私检测，未知格式仍可能未被识别。不会向新增第三方服务发送数据。
- 不记录原始模型请求/响应。故障仅保留原因码；请求失败或超时最多重试 2 次（总计不超过 3 次），期间可随时取消，耗尽后保留原标题，不无限重试。
- 每次请求清理独立计时器和监听器，取消会中止插件的等待和后续重试；若供应商忽略 abort，无法强制终止其底层请求，但迟到结果不会写入标题。
- 单会话单飞，提交前重查原标题、消息指纹、任务代次、location 与归档状态。
- **公开更新接口没有 CAS/条件写入**。极短时间内的外部并发改名及宿主原生标题提交仍有竞态边界，不能承诺绝对不覆盖。
- 插件事件订阅是 live-only；断线使用有上限退避重连，恢复时最多核验 250 条已有托管记录，不批量改历史名称。
- 模型语义判断不是形式化保证；不满意的名称可手动修改并自动锁定。

## 验证

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

可选、会调用真实模型但只发送脚本内合成样例：

```powershell
node scripts/model-smoke.mjs
# 可选：只为本次验收指定模型，不修改全局配置
node scripts/model-smoke.mjs openai/gpt-6-astra#low
# 网络瞬时失败时可只重跑对应样例，单独保存报告、不覆盖已验证结果
node scripts/model-smoke.mjs openai/gpt-6-astra#low technical_array_call
```

全局安装后的隔离会话验收（会调用当前服务的真实模型，自动清理脚本创建的会话）：

```powershell
node scripts/live-smoke.mjs
# 免费模型目录逐项验收；也可在命令后指定 provider/model#variant
node scripts/compatibility-smoke.mjs
```

只读状态命令验收（不调用模型，创建并清理隔离会话；使用真实服务 RPC 和捕获弹窗的客户端适配器，不等同于终端画面的人工验收）：

```powershell
node scripts/status-smoke.mjs
```

`artifacts/` 保存本机验收报告，不包含真实用户聊天。新脚本按版本写入 `model-smoke-v<version>.json` / `live-smoke-v<version>.json`，不覆盖旧版报告。模型验收检查具体字段、方向、条件、多任务及已完成任务保留，不只检查 JSON 能否解析。
公开验收说明和运行方法见 [测试文档](docs/TESTING.md)。本地详细运行报告保存在忽略目录中。

## 常见问题

- **标题没有变化？** 用 `/autotitle-status` 查看是否锁定、无上下文、未达到门槛或仍在冷却；必要时 `/autotitle-refresh`。输出校验失败会保留原标题。
- **状态命令不存在？** 确认使用官方终端版并执行 `/reload`。OpenChamber 等客户端目前未适配这个 TUI 弹窗。
- **模型请求超时？** 提高 `timeoutMs`，或按实际可用模型配置 `model`。`generation_timeout` / `model_failed` 表示生成尝试耗尽。
- **免费模型聊天正常，自动命名却失败？** 升级到最新版本，并检查状态中的“宿主会话瞬时生成”。旧独立通道缺少免费模型所需的宿主上下文，可能返回误导性的 `Free usage limit reached`；仅凭这条错误不能判定额度已耗尽。保留正常会话的系统提示和工具定义，禁用所有工具的诊断会话也可能触发这种拒绝。
- **GitHub Packages 安装出现 401/403/404？** 确认 registry 为 `https://npm.pkg.github.com`，npm 已使用 classic token 登录且具有 `read:packages`。若只想用公开包，改用 npmjs.org 安装或 GitHub 标签直装，并把 `@myoldtime:registry` 切回 `https://registry.npmjs.org`，避免请求被路由到 GitHub Packages。
- **想更新版本？** 固定 tag/版本号不会自动升级；把配置中的版本替换成新版本并 `/reload`。使用非固定版本的安装源可通过 `opencode plugin check` / `opencode plugin update` 检查更新。

## 禁用与卸载

临时禁用：在 `plugins` 列表最后添加 `"-myoldtime.session-autotitle"`，保存后自动重载。

包来源卸载可使用 `opencode plugin remove` 并传入配置中的完整来源，或删除该配置项。本地自动发现目录则需移出 `plugins/`；只删除目录配置项不会关闭自动发现。持久化锁记录不会主动删除。

## 开发、贡献与发布

项目使用原生 ESM 和 Node.js 测试运行器；`@opencode/client` 仅用于开发时真实服务验收。

```text
index.js / tui.js       服务端 / 终端入口
src/controller.mjs     生命周期、锁、调度、请求重试
src/identity.mjs       作者命名空间下的统一标识
src/migration.mjs      旧 ID 状态的一次性导入
migration/             升级期间临时加载的只读存储桥接
src/generation.mjs     宿主生成通道选择与瞬时请求隔离
src/naming.mjs         提示构建、任务列表与输出校验
src/title-format.mjs   标题渲染与旧格式迁移
src/status-*.mjs       只读状态 RPC 与展示
test/                  无需模型凭据的自动化测试
scripts/               需主动运行的真实服务验收
```

- [贡献指南](CONTRIBUTING.md)
- [版本记录](CHANGELOG.md)
- [发布流程](docs/RELEASING.md)
- [提交问题](https://github.com/MyOldTime/opencode-session-autotitle/issues)

发布 GitHub Release 后，既有工作流 `Publish GitHub Package` 通过仓库 `GITHUB_TOKEN` 发布到 **GitHub Packages**，仅覆盖这一个 registry。npmjs.org 的 `@myoldtime/opencode-session-autotitle@0.1.7` 是本次额外的手动发布，仓库尚未配置 npmjs 自动发布，因此两个 registry 的版本需要各自确认。npm 包只包含运行入口、源码和公开文档，不包含测试报告或开发依赖。

维护者手动发布到 npmjs.org 时需同时显式覆盖默认 registry 与 scope registry：`package.json` 的 `publishConfig` 默认指向 GitHub Packages，本机的 `@myoldtime:registry` 也可能指向 `https://npm.pkg.github.com`，而 scope registry 优先于默认 registry。两个参数都给出，发布目标与 scope 路由才会明确落在 npmjs.org：

```sh
npm ci --ignore-scripts
npm publish --registry=https://registry.npmjs.org --@myoldtime:registry=https://registry.npmjs.org --access public
```

命令不传 `--ignore-scripts`，现有 `prepublishOnly` 会在发布前自动执行 `npm run check` 和 `npm test`。若想手工控制测试时机，可先单独运行这两条命令，再在发布命令中加 `--ignore-scripts`。

发布前可用 `npm whoami --registry=https://registry.npmjs.org` 确认登录账号；发布后用同样的 scope 覆盖核验 npmjs.org 上的实际产物：

```sh
npm view @myoldtime/opencode-session-autotitle@0.1.7 dist.tarball --registry=https://registry.npmjs.org --@myoldtime:registry=https://registry.npmjs.org
```

## 许可证

[MIT](LICENSE) © 2026 MyOldTime
