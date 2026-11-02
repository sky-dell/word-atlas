# HTTPS 域名入口与浅色首页

- 唯一应用入口：`https://west.cloud-ip.cc`。
- 生产环境启用 `DOMAIN_ONLY=1`，`APP_ORIGINS` 仅允许上述 HTTPS 域名。
- 页面、资源、健康检查和 API 统一检查原始 Host；IP 或其他 Host 返回 403，不创建账户/游客会话。不信任转发头来绕过检查。
- HTTP 域名请求返回 308 到同域 HTTPS，保留路径与查询参数。HTTP 不再提供应用页面。
- `/.well-known/acme-challenge/` 仅继续提供受限验证文件，供现有域名/IP SAN 证书续期使用；不是应用访问入口。
- 首屏 HTML、登录/注册入口固定浅色。游客创建、恢复时使用浅色主题，保留其他偏好和学习记录。进入后仍可手动切换主题。
- 正式账户已有的主题仍从该账户独立命名空间恢复；登录页的浅色覆盖不会写入正式账户设置。
- 浏览器访问 IP 与域名的 Cookie/存储相互独立。停用 IP 访问不会删除原有账户数据库。

## 验证

`scripts/http-handler.test.mjs` 覆盖域名限制、HTTP 跳转、拒绝 IP/转发头绕过及 ACME 例外。
`src/pages/entry-gate.browser.test.ts` 覆盖深色系统下的浅色登录入口。
`src/pages/mobile-layout.browser.test.ts` 覆盖游客切深色后刷新恢复浅色，同时保留临时身份和学习记录。

已完成完整构建、107 项前端测试、73 项后端测试和 7 项线上检查；验证了 HTTPS 域名、IP 拒绝、HTTP 跳转和游客登录/刷新。结果保存在项目 `.local/domain-only-*` 日志与 `.local/domain-only-live/results.json`。
