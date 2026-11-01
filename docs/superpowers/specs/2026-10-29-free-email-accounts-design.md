# 免费账户、邮箱验证码与下拉入口

用户要求：取消账户顶部游客徽标、取消会员体系；保留用户名注册，增加验证邮箱注册；邮箱支持密码或六位数字验证码登录；验证码五分钟有效；右上角改下拉菜单，不用居中弹窗。发信渠道确认126邮箱 `sz_allen@126.com`，SMTP `smtp.126.com:465` TLS；授权码由用户在主机TTY隐藏输入，绝不进入聊天、代码、日志。已有双模式进入页与临时游客选择保留。

## 行为与边界

- 纯免费账户：所有启用的已登录账号可同步、备份，不再需要管理员授予会员或检查到期。管理员只保留账号禁用/恢复、审计、重置凭据功能。已有用户ID、密码哈希、进度、备份、会话不丢失；旧会员列可作为迁移兼容遗留，不能再控制权限。旧member API及membership返回字段可作为过渡兼容，兼容active对所有启用账号为true；新前端不读取会员字段、不出现会员文案。
- 用户名注册维持 `{username,password,nickname?}`；邮箱注册 `{email,code,password,nickname?}`，仅凭有效注册验证码创建并标记邮箱已验证。邮箱与用户名命名空间分开，邮箱大小写规范化、唯一、长度限制254，不猜测或合并不同邮箱。
- 邮箱账户支持密码登录和验证码登录；用户名账户保留密码登录，不伪造已绑定邮箱。登录identifier可通过旧username字段传用户名或邮箱；也接受明确identifier字段。
- `POST /api/auth/email-code` `{email,purpose:'register'|'login'}` → `{ok:true,retryAfter:60,expiresIn:300}`；用途隔离，注册只发给未注册邮箱，登录只发给已有验证邮箱且启用的账户，统一响应以减少枚举。不配置邮件时明确503并在会话返回emailEnabled:false。
- `POST /api/auth/login-code` `{email,code}` 登录并轮换安全会话；注册沿用register接口。验证码六位含前导0，300000ms有效且边界过期，单次使用，重发旧码失效，60秒冷却；每码最多5次错误，邮箱/IP及全局持久限流。只存带独立secret的HMAC，不存明文码或授权码；发送失败不能留下有效新码，不能回退测试码。
- codeSecret持久保存于root私有邮件配置。改密、禁用、重置、整库恢复撤销相关临时验证码。验证与账户创建/登录原子消费，异步密码计算后再次校验身份、过期与码。邮件发送并发有界，缺配置不影响用户名账户。
- `createAccounts`新增 `sendEmailCode?:({email,purpose,code})=>Promise<void>`、`emailCodeSecret?:string`，测试注入独立发件捕获器；配置发件器时secret必须足够强。
- `createMailerFromEnv(env=process.env)`（server/mailer.mjs）返回 `{enabled,sendCode,close}`。Nodemailer固定已核验版本；TLS证书校验开启，15秒量级超时，禁止文件/URL附件访问、关闭协议日志；只投递验证后的收件地址，from固定126地址。没有完整配置时enabled:false，不向浏览器暴露密钥。
- 配置键 `SMTP_HOST,SMTP_PORT,SMTP_SECURE,SMTP_USER,SMTP_FROM,SMTP_PASS,MAIL_CODE_SECRET`，文件 `/etc/word-atlas/mail.env` root0600，systemd加载。Parent负责TTY配置脚本和服务集成。

## 前端接口

- AccountMenu导出 `AccountMenu({open,onToggle,onClose})`，包含账户图标触发器和右对齐下拉区域。未登录菜单登录/注册，登录后账户资料、数据同步/备份、修改密码、退出，管理员加管理账号。点击菜单项在下拉内切换表单，不创建Sheet/全屏蒙层，不锁页面滚动；点击外部/Esc关闭并恢复图标焦点，窄屏有界可滚动。
- `AccountPanel({initialMode?:'login'|'register'|'reset'})`仍供进入页和兼容深链接使用；移除游客徽标与会员字样。注册可选用户名或邮箱，邮箱有发送验证码与倒计时；登录可选密码或邮箱验证码。邮件未启用时说明不可用，用户名方式仍可用。历史管理员重置流程可留在次级找回入口，不再放主标签。
- User增加email:string|null及emailVerified:boolean；membership只可选兼容。Session增加emailEnabled:boolean。authAction支持login-code，发码通过accountClient。
- 云同步对启用已登录用户开放，保留账号隔离、CAS、冲突备份、配额、API不缓存、HTTPS/CSRF/Origin、密码池等现有保护。

## 验证和发布

迁移前一致性备份，v1→v2保留用户主键和全部进度。先使用临时HTTPS/SQLite和捕获发件器做E2E；真实发信需授权码录入后，只向本发件邮箱测试一次并明确结果。无授权码时不声称已验证真实邮件投递，部署应诚实禁用邮箱发送。保全旧源码/静态目录，兼容旧资源，不能覆盖生产数据库或重置用户工作区。
