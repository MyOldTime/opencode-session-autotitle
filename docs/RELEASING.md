# 发布流程

- 包名：`@myoldtime/opencode-session-autotitle`
- Registry：`https://npm.pkg.github.com`
- 插件 ID：`myoldtime.session-autotitle`

1. 更新 `package.json`、`package-lock.json` 的版本，以及 CHANGELOG、README 和配置示例中的固定版本。
2. 运行 `npm ci --ignore-scripts`、`npm run check`、`npm test`、`npm pack --dry-run`；按变更范围运行真实服务验收。
3. 推送代码，等待 CI 通过；创建对应的 `vX.Y.Z` tag。
4. 为这个 tag 发布 GitHub Release。`Publish GitHub Package` 工作流会校验 tag 与包版本一致，执行测试并发布。
5. 在 Actions 中确认发布及 registry 版本查询成功，然后检查仓库右侧 Packages 和 Release。

工作流只在发布 Release 时运行，使用仓库自带的 `GITHUB_TOKEN`（`packages: write`），不需要保存长期发布 token。已发布版本不可覆盖，后续变更必须递增版本。

## 首次发布后的公开设置

GitHub npm 包的首次发布默认可见性可能为 private，且不会自动继承仓库的 public 可见性。进入该包的 **Package settings → Change visibility → Public**，按页面提示确认。后续版本继承包的可见性。

无论包是否公开，GitHub npm registry 的安装仍需授权；安装者使用带 `read:packages` 的 classic token，或使用 README 中的公开 GitHub 直装方式。
