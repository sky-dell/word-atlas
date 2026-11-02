# Words & Beyond Rebrand Implementation Plan

> **For agentic workers:** Execute inline; user explicitly approved exact brand wording and instructed immediate replacement.

**Goal:** 对外品牌统一为「词与远方 / Words & Beyond / 多懂一个词，多看一点世界。」。
**Architecture:** 只替换对外文案、元数据与下载文件名，保持所有持久化标识兼容。使用现有隔离工作区，验证后发布静态资源和邮件模板。
**Tech Stack:** React、TypeScript、CSS、Node24、Playwright。
**Spec:** 用户本次明确指定的中英文名称及标语；不改变功能和视觉主题。

## Global Constraints
- 保留 localStorage/IndexedDB、cookie、备份 app 字段、dataset ID、API、项目目录及服务名称；不能清空或迁移用户数据。
- 保留上游法律署名、来源URL和历史证据；当前展示、邮件、PWA、分享卡、README使用新品牌。
- 不能盲目替换受版本协议保护的 word-atlas 字符串；不改已部署媒体原件。

## Review Focus
- 四字中文加长英文在320px导航不溢出。
- 分享卡新标语不与名称重叠，旧备份继续可导入。
- HTML、PWA、邮件模板与页面名称一致。
- 所有主路由无旧品牌；保留纯技术标识和合法来源信息。
- 账户与学习回归通过，旧服务缓存不可让入口永久停留旧名称。

### Task 1: Brand replacement
- [x] 新增跨路由品牌、元数据、手机布局、旧存储保留检查；旧构建观察RED。邮件测试先改为新名称断言，观察RED。
- [x] 精确替换源文件与当前文档，适配Logo及分享卡布局，更新PWA与社交卡。
- [x] 构建、前端83项、后端54项、账户E2E8项及品牌检查通过，复核剩余命中分类。独立复核问题已修复，真实Canvas回归先RED后GREEN。

### Task 2: Release
- [x] 备份源码、静态入口及元数据，追加assets并原子更新入口；更新邮件模块并重启服务一次。
- [x] 公网HTTPS三种屏宽验证通过，账户/邮件服务正常，旧兼容标识及署名边界详见 docs/WORDS-AND-BEYOND-REBRAND.md。
