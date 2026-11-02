# Free Email Accounts Implementation Plan

> **For agentic workers:** Use TDD with bounded disjoint parallel workers; parent integrates and reviews, continuing existing authorized development/deployment workflow.

**Goal:** 免费账户、五分钟六位邮箱验证和右上角下拉入口。
**Architecture:** SQLite兼容迁移；后端同源接口/发件器；React复用原账户状态和表单，菜单替代Sheet。
**Tech Stack:** Node24, SQLite, Nodemailer, React/TypeScript, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-29-free-email-accounts-design.md`

## Global Constraints
- 不删除或重建现有账号/学习记录；不放宽HTTPS、CSRF、所有权和配额。
- 授权码不进聊天、日志、仓库；用户本地隐藏输入；邮件缺配置时不能伪造验证码。
- 后端worker只写server/；前端worker写src/但不写App.tsx；parent写App、scripts、deploy、包依赖和运维文档。

## Review Focus
- 验证码并发重放、过期边界、用途混淆、错误次数与重发：后端真实文件库测试。
- 邮件发送失败/缺配置/超时与隐私：发件器和端点测试，不打印码。
- 老账户无邮箱与数据库升级：迁移、备份还原、旧客户端兼容测试。
- 免费云数据仍需身份隔离和CAS：匿名/禁用/错owner和冲突测试。
- 下拉菜单键盘、外部关闭、390px、身份改变：浏览器交互与E2E。

### Task 1: Backend worker
- [x] RED：邮箱校验、免费权限和迁移；GREEN实现spec全部后端契约、邮件模块、更新server测试和README。

### Task 2: Frontend worker
- [x] RED：注册双模式/验证码登录、菜单非弹窗；GREEN实现src账户与管理UI，所有页面去会员文案、保留游客进入及隔离。

### Task 3: Parent integration and deployment
- [x] TTY配置脚本先RED再GREEN；提供安全录入命令，集成邮件环境和server，更新管理CLI撤销邮箱验证码。
- [x] App以AccountMenu替换图标/Sheet；临时库捕获邮件E2E，完整单测/构建/旧学习回归；独立安全复核。
- [x] 备份生产源码和一致性数据库、部署兼容迁移、验证HTTP/HTTPS/账户菜单；真实测试邮件已确认收件，生产 emailEnabled=true。

结果：168 项测试通过；公网 1440px/390px 检查通过。详见 `docs/FREE-ACCOUNTS-REVIEW.md`。
