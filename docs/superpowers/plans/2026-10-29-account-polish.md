# Account Polish Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; user has approved direct execution and deployment.

**Goal:** 精修账户菜单和认证表单，保持业务逻辑与现有主题。
**Architecture:** 复用 AccountMenu / AccountPanel 的状态和事件，只重构呈现与 scoped CSS。隔离工作区验证后，仅部署相关源码与新静态资源。
**Tech Stack:** React、TypeScript、Lucide、现有 CSS variables、Playwright。
**Spec:** docs/superpowers/specs/2026-10-29-account-polish-design.md

## Global Constraints
- 不修改数据库、邮件和认证 API；不增加依赖、不引入 CDN、不修改全站按钮样式。
- 无账户模态遮罩，保留可访问名称和验证码五分钟说明；不展示游客徽标、会员或 GitHub。
- 不删除旧构建资源，不覆盖已有用户改动。

## Review Focus
- 手机短屏和320px：面板可滚动、无溢出，提交按钮可达。
- 主题继承：亮/暗/高对比下输入、文本、焦点清晰。
- 模式切换：邮箱验证码、注册确认密码、凭据重置仍可用。
- 键盘和外部点击：Esc恢复触发器焦点，不锁页面。
- 已登录状态：菜单、云备份、改密、退出行为不变。

### Task 1: Menu and forms
Files: src/ui/AccountMenu.tsx, src/pages/Account.tsx, src/styles/account.css; scripts/account-polish-smoke.mjs.
- [x] 写浏览器回归：菜单紧凑、有区分度的实色主按钮，表单可达，无水平溢出，键盘/切换/主题兼容；对旧构建观察失败。
- [x] 重构呈现；不改变认证函数和请求；构建并验证新回归。
- [x] 全量前端82项与现有真实临时数据库账户8项 E2E 通过，截图人工检查。

### Task 2: Release
Files: docs/ACCOUNT-POLISH-REVIEW.md and production counterparts.
- [x] 独立只读复核，可访问名称问题已补充RED/GREEN测试并修复。
- [x] 备份三个原文件和 index；追加 hashed assets，原子切换 index，无后端重启或迁移。
- [x] 公网 HTTPS 只读检查（1440/390/320px、亮暗主题）6组通过，服务active，结果见 docs/ACCOUNT-POLISH-REVIEW.md。
