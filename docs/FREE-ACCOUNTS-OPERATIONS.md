# 免费账户与126验证码邮件运维

当前账户体系只有免费注册账号及本机创建的管理员角色。不存在收费、会员开通、期限或授权门槛。用户可选择用户名注册，或经邮箱六位验证码验证后注册；邮箱账户可用邮箱+密码或邮箱+验证码登录。旧用户名账户继续使用原密码，未验证绑定的邮箱不能用于登录。

## 入口和数据

登录、注册和凭据重置集中在独立品牌进入页。右上角仅在登录后提供账户下拉菜单：个人中心、真实账户注册信息、账号安全、同步/备份及退出；不使用居中Sheet或全屏蒙层。游客只显示返回入口控件，不展示认证下拉或游客徽标。进入页直接显示登录表单，邮箱服务可用时注册默认邮箱验证，保留用户名注册；游客选择仅在当前标签页临时保存，返回入口不会清空学习记录。所有启用账号均可同步和备份；资料仍按服务端会话所有者和词库隔离，CAS冲突需先备份再选择，不静默覆盖。

服务源码 `/data/word-atlas`；进程 `word-atlas.service`；HTTP80继续游客学习/导出，账户仅HTTPS443。数据库 `/var/lib/word-atlas/accounts.sqlite`（0600），升级为v2时保留旧用户主键、密码哈希、学习记录、备份及会话，增加验证邮箱与临时码表，不重建原库。旧member API/响应字段仅作兼容，不再决定权限。管理员管理页只提供禁用/恢复、审计及受控重置，不提供会员操作或网页提权。

云数据配额仍为每账号40MiB、全站512MiB，每词库最近3份云备份；一致性整库备份每晚保留7份，同机备份不等于异地容灾。

## 邮件配置

发送地址 `sz_allen@126.com`，`smtp.126.com:465`、TLS证书校验开启。root终端录入126客户端授权码，不是邮箱登录密码：

```bash
/usr/local/bin/node /data/word-atlas/scripts/configure-mail.mjs
```

仅在明确替换时添加 `--replace`，替换SMTP授权码时保留现有验证码HMAC密钥。文件 `/etc/word-atlas/mail.env` 为root0600，由服务的EnvironmentFile加载；不要复制到项目、聊天或静态目录。配置后由管理员重启服务生效。

root下发送一封固定收件人为本发件地址的接入测试邮件，不产生登录验证码：

```bash
/usr/local/bin/node /data/word-atlas/scripts/test-mail.mjs
```

SMTP接受不等于收件箱投递；本次用户已经确认收到接入测试邮件。验证码业务E2E使用独立临时HTTPS/SQLite和捕获发件器，不向生产创建测试账号、不发送测试验证码到外部用户。

## 验证码与故障

六位数字含前导0，五分钟有效（到达截止时间即失效），注册/登录用途分开，单次消费，60秒重发冷却，重发旧码失效，最多5次错误。邮箱/IP/全局发送限制持久化，发送并发和超时有界。数据库只保存HMAC，SMTP授权码不进库。改密、禁用、重置会撤销相关码。

邮件配置缺失时会话API的emailEnabled为false，邮箱方式显示不可用，用户名注册/密码登录继续工作。发码接口的正常响应代表接受请求并在符合条件时尝试发送，不能凭响应推断邮箱是否已注册或证明邮件实际送达；实际失败不能留下有效新码。请检查收件箱/垃圾邮件，必要时等待冷却后重试，不要绕过限流或使用固定码。

## 管理、备份及恢复

管理员仍须本机交互创建，无默认密码：

```bash
runuser -u word-atlas -- /usr/local/bin/node /data/word-atlas/scripts/admin.mjs create-admin --username owner_admin
runuser -u word-atlas -- /usr/local/bin/node /data/word-atlas/scripts/admin.mjs backup
```

恢复前停止服务并保全当前数据库/WAL/SHM，使用一致性备份，恢复文件owner为word-atlas、0600；重新启动前执行 `scripts/admin.mjs invalidate-sessions`，清除会话、重置凭据和邮箱码，防止旧备份复活临时凭据。旧SMTP配置与HMAC密钥独立保管，不从用户学习备份中恢复。

审查、测试、发布备份和结果见 `/data/host-audit-20261029/free-accounts/`。历史会员阶段文档不再作为当前功能说明；本文与 `server/README.md` 为当前契约。
