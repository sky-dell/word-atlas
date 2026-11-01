#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createMailerFromEnv } from '../server/mailer.mjs';

if(process.getuid?.()!==0)throw new Error('Please run as root on the host.');
const file='/etc/word-atlas/mail.env';
let mailer;
try {
  const s=await lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077))throw new Error('Private mail configuration permissions are invalid.');
  const env=parseEnv(await readFile(file,'utf8'));mailer=createMailerFromEnv(env);
  if(!mailer.enabled)throw new Error('Mail configuration is incomplete.');
  await mailer.sendTest();
  console.log('SMTP已接受发往 sz_allen@126.com 的接入测试邮件（不含登录验证码）。请检查收件箱或垃圾邮件；SMTP接受不等同于已送达收件箱。');
} catch {
  console.error('邮件接入测试失败；未输出授权码或SMTP协议内容。请检查配置、126授权状态和发信限制。');process.exitCode=1;
} finally {mailer?.close();}
