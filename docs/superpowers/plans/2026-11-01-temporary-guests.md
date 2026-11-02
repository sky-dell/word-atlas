# Temporary Guests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 为词与远方提供可短期恢复且会过期的游客身份，并完成用户名重名检查与游客入口更新。

**Architecture:** 在现有HTTPS服务中接入独立游客模块和独立SQLite库，客户端用内存存储适配器接入现有学习状态。正式账户协议、数据格式和数据库保持兼容。

**Tech Stack:** Node24、node:sqlite、React/TypeScript、现有HTTP处理器、Playwright、node:test。

**Spec:** `docs/superpowers/specs/2026-11-01-temporary-guests.md`

## Global Constraints

- 闲置24小时、创建后最长7天；后台5分钟清理并启动补扫，失效校验不得等待清理任务。
- 临时数据库独立0600，排除正式备份；Cookie独立Secure/HttpOnly/SameSite=Lax。
- 单请求10MiB、单游客20MiB、全库512MiB；不得静默覆盖或丢弃超额数据。
- 不自动删除旧游客或正式账户数据，不把游客学习数据持久化到浏览器。
- 当前生产源码已与旧工作树不同；先读差异，基于当前文件建立隔离工作副本，禁止从旧工作树整体覆盖生产。
- 不读取或输出SMTP授权码，不发送真实验证码做测试，不通过生产库创建测试身份。

## Review Focus

1. 入口启动先于身份确认时，不得先把游客默认状态写入永久存储（任务3）。
2. 旧标签页/断网重试不得复活已清除或过期身份（任务2、3）。
3. 正式账户切换、游客迁移失败及并发更新不得丢失或混写数据（任务3、4）。
4. 异常重启、数据库满、清理报错不得伪报保存成功（任务2、5）。
5. 历史浏览器记录、数据库备份和日志不得绕过游客生命周期（任务3、5）。

### Task 1: 用户名唯一性与建议

**Files:** Modify `server/accounts.mjs`, `server/accounts.test.mjs`, `src/pages/Account.tsx`, `src/account/profiles.browser.test.ts`; Create `src/account/UsernameAvailability.tsx`.

**Interfaces:** `POST /api/auth/username-availability` body `{username}` returns `{available:boolean,suggestions:string[]}`. 使用现有匿名会话CSRF、同源与限流规则；非法格式返回400，无账号资料泄露。

- [x] 写失败测试：大小写冲突、3个可用建议、无效输入、速率限制；注册并发只有一人成功。
- [x] `/usr/local/bin/node --test server/accounts.test.mjs` 观察预期失败，再实现接口，最终注册409返回中文提示并保留唯一约束。
- [x] 输入防抖350ms，仅合法用户名检查；取消旧请求，建议被重新占用时再次提示，不禁用邮箱注册。浏览器测试证明慢响应不覆盖新输入、网络故障不伪报可用、建议键盘可选。
- [x] 通过服务端及相关浏览器测试，审查限定文件差异；不提交用户无关变更。

### Task 2: 独立游客库与HTTPS API

**Files:** Create `server/guests.mjs`, `server/guests.test.mjs`; Modify `scripts/http-handler.mjs`, `scripts/server.mjs`, corresponding HTTP tests.

**Interfaces:** `createGuests({dbPath,now,origins,...}) -> {handle(req,res),cleanup(),close()}`. `GET /api/guest/session` 仅读取；`POST /api/guest/session` 明确创建/恢复；`PUT /api/guest/state?dataset=...` CAS写入 `{version,state}`；GET读取状态；`DELETE /api/guest/session` 确认清除。独立CSRF和身份版本，所有读写均校验过期及来源。

- [x] 先用临时SQLite与注入时间写失败测试：23h刷新恢复、24h闲置拒绝、活跃也不能超过7天、重启可恢复、旧凭证撤销、跨游客拒绝、CSRF、限流和容量上限。
- [x] 实现凭证摘要、正式用户表零新增、事务CAS、明确活动续期与后台清理；记录恢复/清理数量不记录凭证或学习正文。
- [x] 创建时采用独立数据库路径和0600；服务启动/关闭接入资源生命周期；HTTPS之外拒绝游客写入，不影响现有HTTP游客入口的安全跳转说明。
- [x] `/usr/local/bin/node --test server/guests.test.mjs` 及现有服务端套件通过；测试清理失败与数据库满均产生可见失败而非保存成功。

### Task 3: 游客内存存储与服务器恢复

**Files:** Create `src/guest/client.ts`, `src/guest/state.ts`, `src/store/profileStorage.ts`, guest tests; Modify `src/store/persistence.ts`, `src/store/profile.ts`, `src/store/store.ts`, `src/account/entry.ts`, `src/account/state.tsx`, `src/App.tsx`, `src/main.tsx`.

**Interfaces:** `profileStorage` 提供类Storage读写/遍历接口，正式身份委托现有持久存储，游客委托独立内存；`guestState` 暴露启动、恢复、保存、结束、状态订阅与身份代次。服务端游客快照允许未完成会话，正式账户备份仍排除该会话。

- [x] 先写失败测试：首次进入前不永久写入、刷新读取服务器快照、不能读取旧游客localStorage/IDB、跨词库与未完成会话恢复、过期响应被丢弃。
- [x] 梳理并接入所有学习存储调用：`src/lib/reader.ts`, `src/pages/Atlas.tsx`, `src/galaxy/Galaxy.tsx`, `src/ui/EntryIllustration.tsx`, `src/ui/Appearance.tsx`, `src/ui/Splash.tsx`；不改正式账户命名空间。
- [x] 游客学习变更节流保存、切页等待可确认写入；显示保存中/已暂存/未保存/冲突。仅用户实际操作续期，GET和心跳不续期；离线保留内存并告知刷新会丢失未保存变更。
- [x] 测试多标签版本冲突、Cookie过期、正式账户登录/退出、失效重试及浏览器存储不可用，不得落回历史永久游客命名空间。

### Task 4: 游客入口、身份展示与显式迁移

**Files:** Modify `src/pages/EntryGate.tsx`, `src/ui/AccountMenu.tsx`, `src/pages/Me.tsx`, `src/pages/Account.tsx`, `src/styles/entry.css`, `src/styles/account.css`; related browser tests and `scripts/entry-e2e.mjs`, `scripts/free-account-e2e.mjs`.

**Interfaces:** 入口调用任务3的创建/恢复操作，失败不伪装进入；游客显示名只作展示，不能传入正式账户授权接口。

- [x] 先写失败测试：醒目“继续以游客身份登录”、临时编号展示、返回入口不删除、主动清除需确认、到期提示。
- [x] 注册/登录后展示是否导入原游客学习资料；默认不合并。复制成功才清除游客副本，失败保留，账户备份不含游客当前会话。
- [x] 验证深浅主题、320px手机、短窗口和屏幕阅读器标签；保持既有登录布局与邮箱验证码流程。
- [x] 两套隔离HTTPS E2E通过，生产邮箱不发送邮件、正式库不落入测试身份。

### Task 5: 运维、整体审查与发布

**Files:** Modify `deploy/word-atlas.service`, `server/README.md`, `docs/FREE-ACCOUNTS-OPERATIONS.md` as needed; Create `docs/TEMPORARY-GUESTS-REVIEW.md`, `scripts/guest-e2e.mjs`.

- [x] 真实HTTPS临时库E2E用可控时钟验证刷新/重新打开/重启恢复、过期、续期、硬上限、主动删除、迁移隔离与配额失败；断言浏览器无新游客学习永久记录。
- [x] 用临时数据执行现有备份命令，检查备份集合不含游客库；核对主机级快照风险，不擅自修改云端策略。
- [x] 完整前端 `/usr/local/bin/node scripts/run-browser-checks.mjs unit`、完整服务端 `/usr/local/bin/node --test server/*.test.mjs`、隔离E2E及Node24生产构建通过，独立代码审查后修复重要问题。
- [x] 备份准确的生产源文件、入口、服务配置和正式账户库；备份中不复制游客记录。记录文件哈希，避免覆盖用户同期修改。
- [x] 发布限定变更与追加资源，配置独立游客库目录/权限，原子替换入口并重启服务；核对HTTPS健康、正式登录兼容与不创建测试账户的公网只读检查。
- [x] 交付规则、日志指标、容量告警、回退方式与已知限制；不将未完成测试标记通过。
