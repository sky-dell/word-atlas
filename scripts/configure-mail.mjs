#!/usr/bin/env node
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { promptPassword } from './admin.mjs';

export async function saveMailConfiguration({ directory='/etc/word-atlas', authorization, replace=false }) {
  if(typeof authorization!=='string'||!/^[A-Za-z0-9]{8,128}$/.test(authorization))throw new Error('授权码格式无效；请使用126客户端授权码。');
  const dir=resolve(directory);await mkdir(dir,{recursive:true,mode:0o750});const info=await lstat(dir);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw new Error('配置目录必须由root所有且不能由其他用户写入。');
  const file=join(dir,'mail.env');let codeSecret;
  try {
    const target=await lstat(file);
    if(!target.isFile()||target.isSymbolicLink()||target.uid!==0||(target.mode&0o077))throw new Error('配置必须为root私有普通文件，不能使用符号链接。');
    if(!replace)throw new Error('已有邮件配置；如需替换请明确使用 --replace。');
    const old=parseEnv(await readFile(file,'utf8'));
    if(/^[a-f0-9]{64}$/.test(old.MAIL_CODE_SECRET||''))codeSecret=old.MAIL_CODE_SECRET;
  } catch(e) {if(e.code!=='ENOENT')throw e;}
  codeSecret||=randomBytes(32).toString('hex');
  const sender='sz_allen@126.com';
  const data=`SMTP_HOST=smtp.126.com\nSMTP_PORT=465\nSMTP_SECURE=1\nSMTP_USER=${sender}\nSMTP_FROM=${sender}\nSMTP_PASS=${authorization}\nMAIL_CODE_SECRET=${codeSecret}\n`;
  const temporary=join(dir,`.mail-${randomUUID()}.tmp`);const handle=await open(temporary,'wx',0o600);
  try {await handle.writeFile(data);await handle.sync();await handle.close();await rename(temporary,file);}
  catch(e) {await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw e;}
  return {file,sender};
}
async function main(args=process.argv.slice(2)) {
  if(args.length&&!(args.length===1&&args[0]==='--replace'))throw new Error('仅支持可选的 --replace；授权码不能通过参数或管道传入。');
  if(process.getuid?.()!==0)throw new Error('请以root身份在主机交互终端运行。');
  let authorization=await promptPassword('请输入 sz_allen@126.com 的126 SMTP授权码（不回显）：');
  try {
    const result=await saveMailConfiguration({authorization:authorization.trim(),replace:args.includes('--replace')});
    console.log(`已为 ${result.sender} 保存root私有邮件配置（未输出授权码）。请告知录入完成；待功能部署后生效。`);
  } finally {authorization='';}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e.message);process.exitCode=1;});
