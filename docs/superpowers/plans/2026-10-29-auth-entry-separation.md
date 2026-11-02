# Auth Entry Separation Implementation Plan

> **For agentic workers:** Execute scoped parallel work with superpowers:dispatching-parallel-agents; parent integrates and verifies. User approved direct implementation.

**Goal:** 独立品牌认证进入页和登录后专属账户菜单。
**Architecture:** 复用AccountPanel认证逻辑、SignedIn业务子视图；Root管理返回入口和旧路由；菜单只管理已登录身份。
**Tech Stack:** React/TypeScript、现有CSS/Lucide、Node24/SQLite、Playwright。
**Spec:** docs/superpowers/specs/2026-10-29-auth-entry-separation.md

## Global Constraints
- 不迁移、清空或改名用户存储/数据库，不读取或输出邮件授权码。
- 认证保持邮箱/用户名注册、密码/验证码登录和既有安全校验。
- 无模态账户弹窗；不改变个人中心主体、学习流程或收费状态。
- worker仅写EntryGate.tsx与新entry.css；parent负责其余文件，避免共享写入。

## Review Focus
- 默认进入直接有登录表单，注册默认邮箱，但切换用户名仍可用。
- 游客无账户菜单；返回入口/新标签页/旧路由/退出/会话失效不误删记录。
- 当前账户注册时间来自SQLite，只暴露允许公开给本人字段。
- 菜单键盘/关闭/头像/个人中心跳转、320px布局与短屏滚动。
- 跨标签页身份、异步旧请求隔离、旧备份/云同步/改密仍正常。

### Task 1: Entry page worker
- [x] 为进入页直接显示表单和响应式写浏览器RED，新增双栏品牌布局；接口EntryGate({onGuest,initialLogin?})保留，使用AccountPanel preferEmailRegistration。
- [x] worker仅写EntryGate、entry.css及新测试；parent完成真实主题与可访问名称修正。

### Task 2: Parent account and routing
- [x] 先增加createdAt与匿名菜单/登录后菜单行为回归并观察RED。
- [x] AccountPanel添加preferEmailRegistration?:boolean；当前用户createdAt；注册属性列表。
- [x] AccountMenu移除认证视图，添加个人中心/账户注册信息/账号安全；匿名只调用onEnter。Root与Shell传递返回入口并集中保护旧账户/管理路由。
- [x] 更新旧测试，不移除安全验证；89前端、55后端、11账户E2E和8进入E2E通过。

### Task 3: Integrate and release
- [x] 构建、桌面/手机/亮暗截图、独立复核及RED/GREEN修正；学习16、品牌3及页脚2组通过。
- [x] 备份生产源码/一致性数据库，兼容发布后端新字段及静态构建，保留旧资源。
- [x] 生产HTTPS6组只读检查通过，无生产测试账号；报告见docs/AUTH-ENTRY-REVIEW.md。
