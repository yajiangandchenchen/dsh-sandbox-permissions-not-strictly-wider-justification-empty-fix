import { readFile, access, constants } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER = '[sandbox-escalation-fix]';

export const name = 'dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix';

export function apply(ctx) {
  // 该插件的核心功能由 prepare 脚本（scripts/patch.js）在 install 时完成：
  //   1. 修改 dsh-sandbox 的 approveEscalation 函数（throw → return effectiveMode）
  //   2. 修改 pwsh/bash/fs 工具的 import、execute/resolvePolicy、schema 描述
  // 此处 apply() 在每次客户端启动时检查 patch 是否仍然有效，无效则重新应用。
  // 支持多目标：DSH_HOME 端 + 桌面端（硬链接断开后需同时修改两端）

  const checkAndPatch = async () => {
    // 收集所有需要检查的 base 目录
    const baseDirs = [];
    
    // DSH_HOME 端
    const dshHome = process.env.DSH_HOME || (process.env.APPDATA 
      ? join(process.env.APPDATA, 'dsh-desktop', 'harness') 
      : join(process.env.USERPROFILE || '~', '.dsh'));
    
    const dshHomeCandidates = [
      join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
      join(dshHome, 'node_modules', '@deepseek-ai'),
    ];
    
    for (const p of dshHomeCandidates) {
      try { await access(p, constants.R_OK); baseDirs.push(p); break; } catch {}
    }
    
    if (baseDirs.length === 0) {
      // 尝试遍历 profiles 目录
      const { readdirSync } = await import('node:fs');
      const profilesDir = join(dshHome, 'profiles');
      try {
        const entries = readdirSync(profilesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = join(profilesDir, entry.name, 'node_modules', '@deepseek-ai');
          try { await access(candidate, constants.R_OK); baseDirs.push(candidate); break; } catch {}
        }
      } catch {}
    }
    
    // 桌面端
    const desktopCandidates = [
      join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai'),
      join(process.env.ProgramFiles || '', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai'),
    ];
    
    for (const p of desktopCandidates) {
      try { await access(p, constants.R_OK); baseDirs.push(p); } catch {}
    }
    
    if (baseDirs.length === 0) {
      console.warn(`[${name}] 无法检查：无法定位 @deepseek-ai 目录`);
      return;
    }

    // 检查所有位置的所有文件是否都包含 MARKER
    let allPatched = true;
    const files = ['dsh-sandbox', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs'];
    for (const base of baseDirs) {
      for (const f of files) {
        const p = join(base, f, 'lib', 'index.js');
        try {
          const content = await readFile(p, 'utf-8');
          if (!content.includes(MARKER)) allPatched = false;
        } catch {
          allPatched = false;
        }
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

  // 注册卸载钩子：插件卸载时自动恢复原始文件
  ctx.effect(() => {
    return () => {
      try {
        const scriptPath = join(__dirname, 'scripts', 'patch.js');
        execSync(`node ${scriptPath} restore`, { stdio: 'inherit' });
      } catch (e) {
        // 静默失败，避免影响卸载流程
      }
    };
  });
}
