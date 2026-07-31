# 安全策略

## 报告漏洞

如果你发现安全漏洞,请**不要**开公开 Issue。改为私下报告:

- 发邮件到 haorenhui0911@gmail.com,主题加 `[security] cockpit`

请在 24 小时内收到回复。我们会在修复并发布后公开致谢(除非你要求匿名)。

## cockpit 的安全模型(供报告者参考)

- **零直接写入原生 CLI 文件**:cockpit 进程永不 `fs.write`/删除/移动 `~/.claude/projects/` 或 `~/.codex/sessions/` 下任何文件,自身数据只写 `~/.cockpit/`。「回到原会话」模式也只能由官方 CLI 子进程自己 append,cockpit 不解析/改写 jsonl 字节。
- **`:id` 路径参数在解析 filePath 前强制校验**:id 形态 + 最终路径必须 `startsWith` 白名单根目录,否则 404,防路径穿越。
- **Follow-up agent 默认只读**:Codex `read-only` sandbox(禁网/禁搜),Claude 禁用写/exec 工具。敏感路径(`.env*`、`*.pem`、`id_rsa`、`.ssh/`、`.aws/`、`.kube/`、`.git/` 等)过滤同时作用于序列化输入和 tool_result 落盘/回显前。
- **API key 永不进前端 bundle**:仅 server 侧读 `process.env`,禁 `VITE_` 前缀、禁前端 import。
- **本地 API 拒绝跨站浏览器请求**:`Host` 必须是 loopback;浏览器 mutation 的 `Origin` 必须与目标 origin 完全一致,`Sec-Fetch-Site: cross-site` 一律拒绝。命令行客户端不带浏览器 origin header 时仍可本地调用。
- **Electron 导航边界**:静态资源必须严格落在打包 `dist/` 内;主窗口不能导航到其他 origin;系统外链只允许 `http:`、`https:` 和 Cockpit 明确支持的 `codex:` scheme。

## 支持版本

仅最新 release 分支接受安全修复。cockpit 处于早期阶段(0.x),不维护多个 LTS 版本。
