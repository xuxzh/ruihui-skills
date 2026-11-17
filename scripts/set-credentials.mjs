#!/usr/bin/env node
// 写入本机禅道接入凭据：交互式输入，输入不回显，落到只有本人可读的文件里。
//
// 用法：
//   node scripts/set-credentials.mjs        # 交互输入账号与令牌
//   node scripts/set-credentials.mjs --path # 只打印凭据文件位置
//
// 凭据文件（macOS/Linux: ~/.config/rh-zentao/credentials，Windows: %APPDATA%\rh-zentao\credentials）：
//   ZENTAO_ACCOUNT=<账号>
//   ZENTAO_TOKEN=<令牌>
// 脚本不回显、不打印、不上传任何凭据内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function credentialsPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'rh-zentao', 'credentials');
  }
  return path.join(os.homedir(), '.config', 'rh-zentao', 'credentials');
}

/** 读取一行输入；是终端时逐字符回显为 *，管道输入时按普通行读取。 */
function ask(prompt, { hidden = false } = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return new Promise((resolve) => {
    stdout.write(prompt);
    if (!hidden || !stdin.isTTY) {
      stdin.setEncoding('utf8');
      stdin.once('data', (chunk) => {
        const line = String(chunk).split('\n')[0];
        stdout.write('\n');
        resolve(line.trim());
      });
      return;
    }
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        value += ch;
        stdout.write('*');
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const target = credentialsPath();
  if (process.argv.includes('--path')) {
    process.stdout.write(`${target}\n`);
    return;
  }

  const account = await ask('禅道账号: ');
  if (!account) {
    process.stderr.write('账号为空，未写入。\n');
    process.exit(1);
  }
  const token = await ask('禅道令牌（输入不回显）: ', { hidden: true });
  if (!token) {
    process.stderr.write('令牌为空，未写入。\n');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const content = `ZENTAO_ACCOUNT=${account}\nZENTAO_TOKEN=${token}\n`;
  fs.writeFileSync(target, content, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);

  process.stdout.write(`已写入 ${target}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`写入失败：${err.message}\n`);
    process.exit(1);
  });
}
