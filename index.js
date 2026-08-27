import { readFile, access, constants, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER = '[sandbox-escalation-fix]';

export const name = 'sandbox-escalation-fix';

export function apply(ctx) {
  // 该插件的核心功能由 prepare 脚本（scripts/patch.js）在 install 时完成：
  //   1. 修改 dsh-sandbox 的 approveEscalation 函数（throw → return effectiveMode）
  //   2. 修改 pwsh/bash/fs 工具的 import、execute/resolvePolicy、schema 描述
  // 此处 apply() 仅做运行时验证：确认文件已被正确修改。

  const getDshHome = () => {
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    if (process.env.APPDATA) return join(process.env.APPDATA, 'dsh-desktop', 'harness');
    return join(process.env.USERPROFILE || '~', '.dsh');
  };

  const verify = async () => {
    const dshHome = getDshHome();
    const baseDirs = [
      join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
      join(dshHome, 'node_modules', '@deepseek-ai'),
    ];

    let baseDir = null;
    for (const p of baseDirs) {
      try { await access(p, constants.R_OK); baseDir = p; break; } catch {}
    }

    if (!baseDir) {
      console.warn(`[${name}] 无法验证：无法定位 @deepseek-ai 目录`);
      return;
    }

    const files = ['dsh-sandbox', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs'];
    for (const f of files) {
      const p = join(baseDir, f, 'lib', 'index.js');
      try {
        const content = await readFile(p, 'utf-8');
        if (content.includes(MARKER)) {
          console.log(`[${name}] ✓ ${f} 已修改`);
        } else {
          console.warn(`[${name}] ⚠ ${f} 未修改（可能需要在安装后重启 DSH）`);
        }
      } catch {
        console.warn(`[${name}] ⚠ ${f} 文件不存在`);
      }
    }
  };

  // 延迟验证，等待文件系统就绪
  setTimeout(() => verify().catch(() => {}), 1000);
}
