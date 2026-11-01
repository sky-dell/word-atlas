# Entry Modes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this continuing native execution session. Do not reset the dirty production checkout.

**Goal:** 双模式进入、临时游客选择和页面品牌清理。
**Architecture:** App在身份和数据就绪后决定进入页或原Shell；EntryGate复用AccountPanel，entry.ts仅处理标签页临时选择；后端不变。
**Tech Stack:** React/TypeScript、sessionStorage、Playwright、现有SQLite HTTPS测试服务。
**Spec:** `docs/superpowers/specs/2026-10-29-entry-modes-design.md`

## Global Constraints
- 游客选择只在当前标签页有效，不能清除学习记录；不把临时标志当认证凭据。
- 保留源码许可证；只清理页面GitHub相关展示。
- 复用现有安全认证，不向生产库注入测试账号。

## Review Focus
- 存储不可用仍可游客进入：独立浏览器上下文阻止sessionStorage并点击游客。
- 已有登录刷新直接进入：真实HTTPS登录后刷新。
- 退出不能继续沿用临时选择：登录清理选择、退出回入口。
- 深链接与移动端可用：账户深链接及390px点击测试。
- 多页面和图标不残留GitHub：浏览器逐路由检查文本、链接和图标。

## Task 1: 进入流程和品牌清理
- [ ] 新增 `scripts/entry-e2e.mjs`：真实临时HTTPS/SQLite，入口选择、刷新、新标签、登录注册退出、存储受限、全部路由清理；先运行旧构建确认失败。
- [ ] 新增 `src/account/entry.ts` 与 `src/pages/EntryGate.tsx`，修改App、About、Onboarding、index.html和account.css；按spec接入，不更改后端。
- [ ] 更新原有E2E的游客预置，更新footer检查期望新文案；执行build、npm test、新入口E2E、原账号E2E和原学习E2E。
- [ ] 复核源代码，保全旧源码与index，发布新哈希资源和index；真实公网浏览器复验入口、游客、全页面清理，保存日志。保留旧资源兼容已打开标签页。
