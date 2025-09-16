# Zotero Obsidian Daily Exporter

一个面向 Zotero 7 的插件，将每天在 Zotero 中新建的笔记与 PDF 高亮整理后同步到 Obsidian 的每日笔记 Markdown 文件中。插件会在 Zotero 的“工具”菜单中新增“Obsidian 日记”入口，支持手动导出与启动时自动导出。

## 功能概览

- 收集当日新增的 Zotero 普通笔记与 PDF 标注（高亮、批注）。
- 将内容按照条目分组，写入 Obsidian 每日笔记文件的专用区块，并可重复更新而不会产生重复段落。
- 导出区块中包含指向原 Zotero 条目与笔记/标注的 `zotero://` 链接，便于回溯。
- 支持自定义 Obsidian 库路径、每日笔记子目录与文件命名模板（默认 `YYYY-MM-DD.md`）。
- 可选择在 Zotero 启动后自动导出一次，当天多次执行会直接覆盖同一标记区块。

## 仓库结构

```
extension/               # 插件主体，可直接打包成 XPI
  ├── manifest.json       # WebExtension manifest
  ├── bootstrap.js        # 负责加载/卸载插件
  ├── chrome.manifest     # 注册 chrome:// 资源
  ├── chrome/content/     # 实际业务逻辑
  └── icons/              # 插件图标
scripts/package.sh       # 打包脚本，生成 XPI
```

## 打包与安装

1. 在仓库根目录执行 `./scripts/package.sh`（可选传入版本号，例如 `./scripts/package.sh 0.1.0`）。
   - 如未传参，脚本会读取 `extension/manifest.json` 中的 `version` 字段。
   - 成功后会在 `dist/` 目录生成 `zotero-obsidian-daily-<version>.xpi`。
2. 打开 Zotero 7，选择“工具 → 附加组件 → 齿轮按钮 → 从文件安装…”，选中生成的 XPI 文件完成安装。

## Release 下载

仓库不再直接存储二进制 XPI 文件。如无需自行打包，可在发布到 GitHub 时将 `./scripts/package.sh` 生成的成果作为 Release 附件，或下载他人发布的版本。请按照实际仓库地址打开 GitHub 的 “Releases” 页面获取最新打包文件。

## 首次配置

安装完成后，在 Zotero 主窗口中打开“工具 → Obsidian 日记 → 设置…”，依次完成以下内容：

1. 选择 Obsidian 库的根目录。
2. （可选）输入每日笔记相对于库根目录的子路径，可留空表示直接写入库根目录。
3. （可选）自定义每日笔记文件名模板，使用 `YYYY`、`MM`、`DD` 占位符，例如 `Daily/YYYY-MM-DD`。

设置完成后即可通过“立即导出今日笔记”命令执行导出。菜单中还提供“启动时自动导出”选项，可随时开启/关闭。

## 输出格式

插件会在目标 Markdown 文件中插入/更新带标记的区块：

```
<!-- zotero-obsidian-daily:2025-09-16:start -->
## 📥 Zotero 导入（2025-09-16）
> 同步时间：2025-09-16 08:30

### ✏️ 笔记
#### [示例文献标题](zotero://select/items/XXX)
- **[阅读摘要](zotero://select/items/YYY)**（08:15）
  第一段内容
  第二段内容

### 🔖 高亮
#### [示例文献标题](zotero://select/items/XXX)
- [高亮](zotero://select/items/ZZZ)（第 3 页 · 09:02）
  > 被高亮的原文
  > 💬 个人批注

<!-- zotero-obsidian-daily:2025-09-16:end -->
```

再次导出同一天时会直接替换该区块内容，不会生成重复段落。若当天没有新笔记或高亮，手动导出会提示“今天没有新的 Zotero 笔记或高亮”。

## 自动导出说明

- 默认开启“启动时自动导出”，插件会在 Zotero 启动完成后自动执行一次导出。
- 自动导出仅在找到新内容时写入文件，同时会记录最近一次导出日期，避免同一天多次重复运行。
- 若未配置 Obsidian 路径，自动导出会被跳过，可在工具菜单中补充设置。

## 已知限制

- 笔记内容的 Markdown 转换针对常见段落/列表/加粗/链接等进行了适配，但对于复杂嵌套样式可能仍需要手动微调。
- Obsidian 文件若包含第三方模板生成的同名区块，请确保标记区块（`<!-- zotero-obsidian-daily:... -->`）不被删除，以便后续覆盖。
- 脚本依赖 `python3` 与 `zip` 命令。若在 Windows 上打包，可在 WSL 或其他类 Unix 环境中运行脚本。

## 开发调试

- 修改 `extension/` 内文件后可直接重新执行打包脚本生成新的 XPI。
- Zotero 控制台（`调试输出`）会打印导出日志与潜在错误，便于排查。

