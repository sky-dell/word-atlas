# 安全与隐私 / Security and privacy

## 数据去哪里

游客可直接学习。学习进度优先保存在当前浏览器的 IndexedDB，阅读、外观等附加数据使用 localStorage；注册账号后按账号隔离，退出不删除原资料。所有启用的注册账号均可免费同步和备份，不存在会员等级、付费或到期授权。云端学习快照保存在本机服务端 SQLite。未完成的答题会话仅在本机保存，不上传到云端。游客选择只在当前标签页临时保留，不因此删除既有学习记录。

Account login requires HTTPS. Passwords are salted slow hashes, session/reset tokens are stored as hashes, and the session cookie is Secure/HttpOnly/SameSite. All account APIs enforce server-side identity, account status and ownership checks; API responses are never offline-cached. Anonymous learning remains available without registration. No analytics or tracking has been added.

服务端账号、验证邮箱、学习快照与操作记录位于 `/var/lib/word-atlas/accounts.sqlite`，不在静态目录或发布包中。注册用户的最新学习快照持续保存、不会自动到期，登录后可自动恢复；用户手动云端备份用于历史回滚。数据库采用事务、WAL 与一致性备份，保留最近 7 份本机数据库备份。每词库最多 3 份用户云端备份，默认每账号云数据总额 40 MiB、全部云数据 512 MiB；这些限额可由部署配置调整。本机备份不等同于异地容灾。旧授权列仅为兼容历史库保留，不再决定任何免费账户权限。

普通会话最长 7 天，匿名 CSRF 会话 1 小时，一次性重置凭据 30 分钟；邮箱验证码为6位数字、5分钟有效、用途隔离、单次消费，重发使旧码失效，最多5次错误。验证码仅保存带独立secret的HMAC，不保存明文；邮件发送、验证和密码计算均有限流或并发上限。过期立即失效，过期记录在后续 API 请求时清理。密码更改、账号禁用和重置会撤销会话及相关验证码。管理员身份只能经本机交互 CLI 建立，不提供默认密码或公开提权入口。

浏览器按账号分区不等于保护整台共享设备：本机操作系统用户、浏览器开发工具或同源脚本仍可能访问本机存储。HTTP/HTTPS 属于不同 origin，需要通过 JSON 导入导出迁移既有记录。线上部署前必须启用有效 HTTPS，不得把开发用非安全模式暴露公网。

## 凭据 / Credentials

网页运行不需要任何 API key。只有 `scripts/atlas/` 中的内容生成脚本需要调用模型服务，它们从环境变量（`SUB2_BASE_URL`、`SUB2_API_KEY`、`ELEVENLABS_API_KEY`）或仓库外的目录（`ATLAS_SECRETS`）读取凭据，不会写入仓库。

验证码邮件支持任意符合要求的 SMTP 服务商，只允许隐式 TLS 或 STARTTLS，并强制校验证书与使用 TLS 1.2 以上。SMTP 授权码与验证码 HMAC 密钥只放在 `/etc/word-atlas/mail.env`（root 所有、0600），由 systemd 加载，不写入源码、静态包、数据库、日志或聊天。可通过管理页或交互工具 `scripts/configure-mail.mjs` 隐藏录入；缺少配置时邮箱服务明确不可用，不能使用固定测试验证码作为生产回退。恢复旧数据库后必须执行 `scripts/admin.mjs invalidate-sessions`，同时清除会话、重置凭据及邮箱验证码。

- 不要使用 `VITE_*` 变量存放凭据，它们会被打包进浏览器代码。
- 公开前运行 `npm run pack:public`，它会按白名单导出并扫描凭据和个人路径。扫描是辅助手段，不能替代人工检查。
- 如果凭据意外泄露，请立刻在服务商处吊销或轮换。

## 报告问题 / Reporting

发现安全问题请通过可信私密渠道联系本站管理员，不要公开贴出账号凭据、授权码或漏洞利用细节。
