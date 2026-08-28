# sandbox-escalation-fix

[English](README.md) | 中文

一个 DSH 插件，修复 `sandbox_permissions` 和 `justification` 字段在 `pwsh`、`bash`、`fs`（write/edit）、`dsh-sandbox` 四个工具中的两个相关 bug。

## Bug 描述

当会话已经是 `danger-full-access` 模式时，可能触发两个错误：

1. **空 justification**：模型发送 `justification: ""`（空字符串），触发 `validateEscalationArgs` 抛出 `invalid justification: expected a non-empty sentence`
2. **no-op 升级**：模型发送 `sandbox_permissions: "danger-full-access"`（与当前模式相同），触发 `approveEscalation` 抛出 `sandbox escalation to "X" is not strictly wider`

这是第 4 次独立报告（[GitHub #3519](https://github.com/deepseek-ai/deepseek-harness/discussions/3519) → [#4359](https://github.com/deepseek-ai/deepseek-harness/discussions/4359) → [#4383](https://github.com/deepseek-ai/deepseek-harness/discussions/4383) → [#4412](https://github.com/deepseek-ai/deepseek-harness/discussions/4412)），影响所有使用非默认模型的会话。

## 修复方案

两层防御：

1. **Schema 描述**：更新为明确说明 same-mode retry 是 no-op，减少模型发送空字段的倾向
2. **运行时归一化**：在每个工具的 execute/resolvePolicy 入口添加归一化逻辑，当请求的模式不比当前模式更宽时清除升级参数

## 工作原理

- **安装**（`dsh plugin add`）：插件安装到 profile 目录，Cordis 注入动态插件行
- **首次加载**：`index.js` 的 `apply()` 函数运行 `patch.js apply`，备份原始文件并应用所有修改。此过程在首次加载时自动完成
- **自动修复**：每次客户端启动/重启时，插件检查 patch 是否仍然有效。如果 patch 丢失（如桌面端更新后），自动重新应用
- **多目标**：插件检测 DSH_HOME 和桌面端安装目录。如果硬链接已断开（如桌面端更新后），同时修改两端
- **卸载**（`dsh plugin remove`）：`preuninstall` 脚本运行 `patch.js restore`，从备份恢复所有原始文件

## 安装

```sh
dsh plugin --profile <your-profile> add github:yajiangandchenchen/dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix
```

## 卸载

```sh
dsh plugin --profile <your-profile> remove dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix
```

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `dsh-sandbox/lib/index.js` | `approveEscalation`：throw → return effectiveMode |
| `dsh-tool-pwsh/lib/index.js` | import +WIDER_MODES、execute 归一化、schema 描述 |
| `dsh-tool-bash/lib/index.js` | import +WIDER_MODES、execute 归一化、schema 描述 |
| `dsh-tool-fs/lib/index.js` | import +WIDER_MODES、resolvePolicy 归一化、schema 描述 |

## 兼容性

- 兼容最新 `dsh-std` 插件元协定
- 不与其他插件冲突（仅修改工具实现文件）
- 桌面端和 WebUI 均支持（修改 DSH_HOME，与桌面端硬链接）

## 许可证

MIT
