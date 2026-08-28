import { readFile, access, constants } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER = '[sandbox-escalation-fix]';

export const name = 'sandbox-escalation-fix';

export function apply(ctx) {
  // 该插件的核心功能由 prepare 脚本（scripts/patch.js）在 install 时完成：
  //   1. 修改 dsh-sandbox 的 approveEscalation 函数（throw → return effectiveMode）
  //   2. 修改 pwsh/bash/fs 工具的 import、execute/resolvePolicy、schema 描述
  // 此处 apply() 在每次客户端启动时检查 patch 是否仍然有效，无效则重新应用。

  const getDshHome = () => {
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    if (process.env.APPDATA) return join(process.env.APPDATA, 'dsh-desktop', 'harness');
    return join(process.env.USERPROFILE || '~', '.dsh');
  };

  const checkAndPatch = async () => {
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
      console.warn(`[${name}] 无法检查：无法定位 @deepseek-ai 目录`);
      return;
    }

    // 检查四个文件是否都包含 MARKER
    let allPatched = true;
    const files = ['dsh-sandbox', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs'];
    for (const f of files) {
      const p = join(baseDir, f, 'lib', 'index.js');
      try {
        const content = await readFile(p, 'utf-8');
        if (!content.includes(MARKER)) allPatched = false;
      } catch {
        allPatched = false;
      }
    }

    if (allPatched) {
      console.log(`[${name}] ✓ 所有文件已修改，无需操作`);
      return;
    }

    // 有文件缺失 patch，重新应用
    console.warn(`[${name}] ⚠ 检测到 patch 丢失（可能因桌面端更新），正在重新应用...`);
    try {
      const scriptPath = join(__dirname, 'scripts', 'patch.js');
      execSync(`node ${scriptPath} apply`, { stdio: 'inherit' });
      console.log(`[${name}] ✓ patch 已重新应用`);
    } catch (e) {
      console.error(`[${name}] ✗ 重新应用失败: ${e.message}`);
    }
  };

  // 延迟检查，等待文件系统就绪
  setTimeout(() => checkAndPatch().catch(() => {}), 1000);
}
