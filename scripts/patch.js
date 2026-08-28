#!/usr/bin/env node
/**
 * sandbox-escalation-fix / scripts/patch.js
 * 
 * 修复 sandbox_permissions 和 justification 字段在 pwsh/bash/fs/dsh-sandbox 中的 bug。
 * 匹配策略：锚点定位 + 精确行替换（忽略空白差异）。
 * 
 * 用法：
 *   node scripts/patch.js apply     # 备份 + 应用修改
 *   node scripts/patch.js restore   # 从备份恢复
 *   node scripts/patch.js status    # 检查当前状态
 *   node scripts/patch.js debug     # 诊断模式
 */

import { accessSync, constants, openSync, closeSync, writeSync, ftruncateSync, readdirSync } from 'node:fs';
import { access as accessAsync, readFile as readFileAsync, writeFile as writeFileAsync, mkdir as mkdirAsync, copyFile as copyFileAsync, readdir as readdirAsync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER = '[sandbox-escalation-fix]';

// 备份存放在持久化位置（插件目录外），这样卸载后仍能恢复
function getBackupDir() {
  const dshHome = process.env.DSH_HOME || (process.env.APPDATA 
    ? join(process.env.APPDATA, 'dsh-desktop', 'harness') 
    : join(process.env.USERPROFILE || '~', '.dsh'));
  return join(dshHome, 'backups', 'sandbox-escalation-fix');
}

const BACKUP_DIR = getBackupDir();

// ── 目标文件定位 ──────────────────────────────────────────────────────────────

function getDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (process.env.APPDATA) return join(process.env.APPDATA, 'dsh-desktop', 'harness');
  return join(process.env.USERPROFILE || '~', '.dsh');
}

/**
 * 使用 fsutil 获取一个文件的所有硬链接路径。
 * 如果硬链接已断开，返回的列表只包含自身。
 */
function getHardLinks(filePath) {
  try {
    const output = execSync(`fsutil hardlink list "${filePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  } catch {
    return [filePath];
  }
}

/**
 * 查找 DSH_HOME 的 node_modules 基础路径
 */
function findDshHomeBase() {
  const dshHome = getDshHome();
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
    join(dshHome, 'node_modules', '@deepseek-ai'),
  ];
  
  for (const p of candidates) {
    try { accessSync(p, constants.R_OK | constants.W_OK); return p; } catch {}
  }
  
  // 尝试遍历 profiles 目录
  const profilesDir = join(dshHome, 'profiles');
  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(profilesDir, entry.name, 'node_modules', '@deepseek-ai');
      try { accessSync(candidate, constants.R_OK | constants.W_OK); return candidate; } catch {}
    }
  } catch { /* ignore */ }
  
  return null;
}

/**
 * 通过硬链接关系查找所有需要修改的目标路径。
 * 核心逻辑：DSH_HOME 的某些文件可能通过硬链接与其他位置共享。
 * 通过 fsutil hardlink list 获取所有硬链接路径，动态确定修改目标。
 */
function findAllTargets() {
  const dshBase = findDshHomeBase();
  if (!dshBase) {
    throw new Error('无法定位 @deepseek-ai 目录。');
  }
  
  // 取一个测试文件来探测硬链接关系
  const testFile = join(dshBase, 'dsh-sandbox', 'lib', 'index.js');
  const allHardLinks = getHardLinks(testFile);
  
  // 收集所有硬链接路径（去重）
  const targetSet = new Set();
  targetSet.add(dshBase);
  
  for (const linkPath of allHardLinks) {
    // 从硬链接路径反推 @deepseek-ai 基础目录
    const aiIndex = linkPath.indexOf('@deepseek-ai');
    if (aiIndex > 0) {
      targetSet.add(linkPath.substring(0, aiIndex + '@deepseek-ai'.length));
    }
  }
  
  // 过滤掉不存在或不可写的路径
  const targets = [];
  for (const base of targetSet) {
    try {
      accessSync(base, constants.R_OK | constants.W_OK);
      const isDshHome = base.startsWith(getDshHome());
      targets.push({ base, label: isDshHome ? 'DSH_HOME' : 'Linked' });
    } catch { /* 跳过不可访问的路径 */ }
  }
  
  if (targets.length === 0) {
    throw new Error('无法定位 @deepseek-ai 目录。');
  }
  
  return targets;
}

async function findNodeModulesBase() {
  const targets = findAllTargets();
  return targets[0].base;
}

// ── 备份与恢复 ────────────────────────────────────────────────────────────────

function getBackupPath(srcPath) {
  const hash = createHash('sha256').update(srcPath).digest('hex').slice(0, 12);
  const backupName = `${hash}_${encodeURIComponent(srcPath)}`;
  return join(BACKUP_DIR, backupName);
}

async function backupFile(srcPath) {
  const backupPath = getBackupPath(srcPath);
  await mkdirAsync(BACKUP_DIR, { recursive: true });
  // 如果备份已存在，直接返回（保证备份始终是原始版本）
  try { await accessAsync(backupPath, constants.R_OK); return backupPath; } catch {}
  // 如果文件已被修改（有 MARKER），说明这是二次运行，原始备份应已存在
  try {
    const content = await readFileAsync(srcPath, 'utf-8');
    if (content.includes(MARKER)) {
      return backupPath;
    }
  } catch {}
  // 直接备份用户当前的文件（修改之前的状态）
  await copyFileAsync(srcPath, backupPath);
  return backupPath;
}

/**
 * 检查两个文件是否是同一文件（硬链接）
 */
function isSameFile(path1, path2) {
  try {
    const links = getHardLinks(path1);
    return links.some(l => l.toLowerCase() === path2.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 尝试恢复硬链接（如果源文件存在且内容相同）
 */
function tryRestoreHardLink(srcPath, targetPath) {
  try {
    // 检查源文件和目标文件是否内容相同
    const srcContent = require('node:fs').readFileSync(srcPath, 'utf-8');
    const targetContent = require('node:fs').readFileSync(targetPath, 'utf-8');
    if (srcContent === targetContent) {
      // 内容相同，可以尝试创建硬链接
      try {
        require('node:fs').linkSync(srcPath, targetPath);
        return true;
      } catch {
        return false;
      }
    }
  } catch {}
  return false;
}

async function restoreFile(srcPath) {
  const backupPath = getBackupPath(srcPath);
  try { await accessAsync(backupPath, constants.R_OK); } catch { return false; }
  // 读取备份内容，用 writeFileInPlace 恢复，保持硬链接不被断开
  const backupContent = await readFileAsync(backupPath, 'utf-8');
  writeFileInPlace(srcPath, backupContent);
  return true;
}

/**
 * 原地修改文件内容，保持硬链接不被断开。
 * 使用 r+ 模式打开文件（不截断），写入新内容后截断到目标长度。
 * 这样修改不会创建新文件，硬链接得以保留。
 */
function writeFileInPlace(filePath, content) {
  const fd = openSync(filePath, 'r+');
  try {
    const buffer = Buffer.from(content, 'utf-8');
    writeSync(fd, buffer, 0, buffer.length, 0);
    ftruncateSync(fd, buffer.length);
  } finally {
    closeSync(fd);
  }
}

// ── 核心：行级匹配（忽略空白差异） ────────────────────────────────────────────

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function findLine(lines, target, start = 0) {
  const t = norm(target);
  for (let i = start; i < lines.length; i++) {
    if (norm(lines[i]) === t) return i;
  }
  return -1;
}

function replaceLine(content, target, replacement) {
  const lines = content.split('\n');
  const idx = findLine(lines, target);
  if (idx === -1) return { result: content, line: -1 };
  const indent = lines[idx].match(/^\s*/)[0];
  lines[idx] = indent + replacement;
  return { result: lines.join('\n'), line: idx };
}

function insertAfter(content, anchor, newLines) {
  const lines = content.split('\n');
  const idx = findLine(lines, anchor);
  if (idx === -1) return { result: content, line: -1 };
  const indent = lines[idx].match(/^\s*/)[0];
  const inserted = newLines.map(l => l.length > 0 ? indent + l : l);
  lines.splice(idx + 1, 0, ...inserted);
  return { result: lines.join('\n'), line: idx + 1 };
}

function replaceRange(content, anchor, end, newLines) {
  const lines = content.split('\n');
  const startIdx = findLine(lines, anchor);
  if (startIdx === -1) return { result: content, line: -1 };
  const endIdx = findLine(lines, end, startIdx);
  if (endIdx === -1) return { result: content, line: -1 };
  const indent = lines[startIdx].match(/^\s*/)[0];
  const inserted = newLines.map(l => l.length > 0 ? indent + l : l);
  lines.splice(startIdx, endIdx - startIdx + 1, ...inserted);
  return { result: lines.join('\n'), line: startIdx };
}

// ── 修改定义（基于官方源码精确文本） ─────────────────────────────────────────

const SCHEMA_SANDBOX_NEW = 'The wider sandbox mode this command needs. Escalating to a strictly wider mode requires justification and user approval; a retry at the call\'s current effective mode is accepted as a no-op.';
const SCHEMA_JUSTIF_NEW = 'Required only when sandbox_permissions escalates to a strictly wider mode: one sentence for the user explaining why this exact command needs the wider access. Not needed for a same-mode retry (no-op).';
const SCHEMA_FS_NEW = 'The wider sandbox mode this file operation needs. Escalating to a strictly wider mode requires justification and user approval; a retry at the call\'s current effective mode is accepted as a no-op.';
const SCHEMA_FS_JUSTIF_NEW = 'Required only when sandbox_permissions escalates to a strictly wider mode: one sentence for the user explaining why this exact file operation needs the wider access. Not needed for a same-mode retry (no-op).';

function getOpsForSandbox() {
  return [{
    desc: 'approveEscalation: throw → return effectiveMode',
    type: 'replaceRange',
    anchor: 'async function approveEscalation(request, approval) {',
    end: 'if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);',
    newLines: [
      `// ${MARKER} No-op: requested mode is not strictly wider than the effective mode`,
      '// (equal or narrower). Grants nothing beyond what the call already holds,',
      '// so no approval round-trip is needed. Genuine widening still flows through',
      '// the approval channel below. This also covers danger-full-access, which has',
      '// no key in WIDER_MODES and previously always threw here.',
      'if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) return effectiveMode;'
    ]
  }];
}

function getOpsForPwsh() {
  return [
    {
      desc: 'import: 添加 WIDER_MODES',
      type: 'replaceLine',
      target: 'import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";',
      replacement: 'import { ESCALATION_TARGETS, WIDER_MODES, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";'
    },
    {
      desc: 'execute: 添加归一化逻辑',
      type: 'insertAfter',
      anchor: 'const standingPolicy = resolveSandboxPolicy(exec);',
      newLines: [
        `// ${MARKER}: 归一化无操作升级`,
        'if (args.sandbox_permissions !== void 0 && !(WIDER_MODES[standingPolicy.mode] ?? []).includes(args.sandbox_permissions)) args = { ...args, sandbox_permissions: void 0, justification: void 0 };'
      ]
    },
    {
      desc: 'schema: sandbox_permissions 描述',
      type: 'replaceLine',
      target: 'description: "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval."',
      replacement: `description: "${SCHEMA_SANDBOX_NEW}"`
    },
    {
      desc: 'schema: justification 描述',
      type: 'replaceLine',
      target: 'description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."',
      replacement: `description: "${SCHEMA_JUSTIF_NEW}"`
    }
  ];
}

function getOpsForBash() {
  return [
    {
      desc: 'import: 添加 WIDER_MODES',
      type: 'replaceLine',
      target: 'import { ESCALATION_TARGETS, approveEscalation, canonicalPath, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";',
      replacement: 'import { ESCALATION_TARGETS, WIDER_MODES, approveEscalation, canonicalPath, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";'
    },
    {
      desc: 'execute: 添加归一化逻辑',
      type: 'replaceRange',
      anchor: 'async execute(args, exec) {',
      end: 'validateBashArgs(args);',
      newLines: [
        'const standingPolicy = resolveSandboxPolicy(exec);',
        `// ${MARKER}: 归一化无操作升级`,
        'if (args.sandbox_permissions !== void 0 && !(WIDER_MODES[standingPolicy.mode] ?? []).includes(args.sandbox_permissions)) args = { ...args, sandbox_permissions: void 0, justification: void 0 };',
        'validateBashArgs(args);'
      ]
    },
    {
      desc: 'schema: sandbox_permissions 描述',
      type: 'replaceLine',
      target: 'description: "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval."',
      replacement: `description: "${SCHEMA_SANDBOX_NEW}"`
    },
    {
      desc: 'schema: justification 描述',
      type: 'replaceLine',
      target: 'description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."',
      replacement: `description: "${SCHEMA_JUSTIF_NEW}"`
    }
  ];
}

function getOpsForFs() {
  return [
    {
      desc: 'import: 添加 WIDER_MODES',
      type: 'replaceLine',
      target: 'import { ESCALATION_TARGETS, approveEscalation, canonicalPath, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";',
      replacement: 'import { ESCALATION_TARGETS, WIDER_MODES, approveEscalation, canonicalPath, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";'
    },
    {
      desc: 'resolvePolicy: 添加归一化逻辑',
      type: 'insertAfter',
      anchor: 'const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });',
      newLines: [
        `// ${MARKER}: 归一化无操作升级`,
        'if (args.sandbox_permissions !== void 0 && !(WIDER_MODES[standingPolicy.mode] ?? []).includes(args.sandbox_permissions)) args = { ...args, sandbox_permissions: void 0, justification: void 0 };'
      ]
    },
    {
      desc: 'schema: sandbox_permissions 描述',
      type: 'replaceLine',
      target: 'description: "The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval."',
      replacement: `description: "${SCHEMA_FS_NEW}"`
    },
    {
      desc: 'schema: justification 描述',
      type: 'replaceLine',
      target: 'description: "Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access."',
      replacement: `description: "${SCHEMA_FS_JUSTIF_NEW}"`
    }
  ];
}

// ── 应用修改 ──────────────────────────────────────────────────────────────────

function applyOps(content, ops) {
  let result = content;
  const log = [];

  for (const op of ops) {
    let alreadyApplied = false;
    
    if (op.type === 'replaceLine') {
      // 对于单行替换：检查目标是否还存在，且替换文本不存在
      const targetExists = findLine(result.split('\n'), op.target) >= 0;
      const replacementExists = result.includes(op.replacement);
      if (!targetExists || replacementExists) {
        alreadyApplied = true;
      }
    } else if (op.type === 'insertAfter') {
      // 对于插入：检查 MARKER 是否已存在
      if (result.includes(MARKER)) {
        alreadyApplied = true;
      }
    } else if (op.type === 'replaceRange') {
      // 对于范围替换：检查 MARKER 是否已存在
      if (result.includes(MARKER)) {
        alreadyApplied = true;
      }
    }

    if (alreadyApplied) {
      log.push(`  ✓ ${op.desc}（已是目标状态，跳过）`);
      continue;
    }

    let r;
    switch (op.type) {
      case 'replaceLine':
        r = replaceLine(result, op.target, op.replacement);
        break;
      case 'insertAfter':
        r = insertAfter(result, op.anchor, op.newLines);
        break;
      case 'replaceRange':
        r = replaceRange(result, op.anchor, op.end, op.newLines);
        break;
      default:
        r = { result, line: -1 };
    }

    if (r.line === -1) {
      log.push(`  ⚠ ${op.desc}：未找到目标，跳过`);
    } else {
      result = r.result;
      log.push(`  ✓ ${op.desc}（行 ${r.line + 1}）`);
    }
  }

  return { result, log };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  if (!['apply', 'restore', 'status', 'debug', 'check'].includes(command)) {
    console.error('用法: node scripts/patch.js <apply|restore|status|debug|check>');
    process.exit(1);
  }

  // 查找所有需要修改的目标（DSH_HOME + 桌面端）
  const allTargets = findAllTargets();
  console.log(`找到 ${allTargets.length} 个目标位置:`);
  for (const tgt of allTargets) {
    console.log(`  [${tgt.label}] ${tgt.base}`);
  }

  // 构建文件目标列表
  const fileNames = [
    { name: 'dsh-sandbox', getOps: getOpsForSandbox },
    { name: 'dsh-tool-pwsh', getOps: getOpsForPwsh },
    { name: 'dsh-tool-bash', getOps: getOpsForBash },
    { name: 'dsh-tool-fs', getOps: getOpsForFs },
  ];

  // 展开为所有位置 × 所有文件
  const targets = [];
  for (const tgt of allTargets) {
    for (const f of fileNames) {
      targets.push({
        path: join(tgt.base, f.name, 'lib', 'index.js'),
        getOps: f.getOps,
        label: tgt.label,
        fileName: f.name,
      });
    }
  }

  if (command === 'status') {
    for (const t of targets) {
      const backupPath = getBackupPath(t.path);
      let hasBackup = false;
      try { await accessAsync(backupPath, constants.R_OK); hasBackup = true; } catch {}
      let exists = false;
      try { await accessAsync(t.path, constants.R_OK); exists = true; } catch {}
      const rel = `${t.label}\\${t.fileName}`;
      console.log(`${exists ? '✓' : '✗'} ${rel}  ${hasBackup ? '[有备份]' : '[无备份]'}`);
    }
    return;
  }

  if (command === 'check') {
    // 检查所有位置的所有文件是否都包含 MARKER
    let allPatched = true;
    for (const t of targets) {
      try {
        await accessAsync(t.path, constants.R_OK);
        const content = await readFile(t.path, 'utf-8');
        if (!content.includes(MARKER)) allPatched = false;
      } catch {
        allPatched = false;
      }
    }
    console.log(allPatched ? 'PATCHED' : 'NEED_PATCH');
    return;
  }

  if (command === 'restore') {
    for (const t of targets) {
      const restored = await restoreFile(t.path);
      const rel = `${t.label}\\${t.fileName}`;
      console.log(restored ? `✓ 已恢复: ${rel}` : `⚠ 无备份跳过: ${rel}`);
    }
    // 恢复后尝试重建硬链接
    if (allTargets.length > 1) {
      const dshBase = allTargets[0].base;
      const desktopBase = allTargets[1]?.base;
      if (desktopBase) {
        console.log('\n尝试重建硬链接...');
        const fileNames = ['dsh-sandbox', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs'];
        for (const f of fileNames) {
          const dshPath = join(dshBase, f, 'lib', 'index.js');
          const desktopPath = join(desktopBase, f, 'lib', 'index.js');
          if (tryRestoreHardLink(dshPath, desktopPath)) {
            console.log(`  ✓ 已重建硬链接: ${f}`);
          }
        }
      }
    }
    return;
  }

  if (command === 'debug') {
    for (const t of targets) {
      const rel = `${t.label}\\${t.fileName}`;
      try { await accessAsync(t.path, constants.R_OK); } catch { console.log(`✗ 不存在: ${rel}`); continue; }
      const content = await readFileAsync(t.path, 'utf-8');
      const lines = content.split('\n');
      const ops = t.getOps();
      console.log(`\n--- ${rel} ---`);
      for (const op of ops) {
        if (op.type === 'replaceLine') {
          const idx = findLine(lines, op.target);
          console.log(`  ${idx >= 0 ? '✓' : '✗'} [replaceLine] ${op.desc}: 行 ${idx >= 0 ? idx + 1 : '未找到'}`);
        } else if (op.type === 'insertAfter') {
          const idx = findLine(lines, op.anchor);
          console.log(`  ${idx >= 0 ? '✓' : '✗'} [insertAfter] ${op.desc}: 锚点行 ${idx >= 0 ? idx + 1 : '未找到'}`);
        } else if (op.type === 'replaceRange') {
          const s = findLine(lines, op.anchor);
          const e = findLine(lines, op.end, s >= 0 ? s : 0);
          console.log(`  ${s >= 0 && e >= 0 ? '✓' : '✗'} [replaceRange] ${op.desc}: 锚点=${s + 1}, 结束=${e + 1}`);
        }
      }
    }
    return;
  }

  // apply - 使用原地修改保持硬链接
  for (const t of targets) {
    const rel = `${t.label}\\${t.fileName}`;
    try { await accessAsync(t.path, constants.R_OK); } catch { console.log(`✗ 不存在: ${rel}`); continue; }
    const original = await readFileAsync(t.path, 'utf-8');
    await backupFile(t.path);
    const ops = t.getOps();
    const { result, log } = applyOps(original, ops);
    // 使用原地修改（r+ 模式）保持硬链接不被断开
    writeFileInPlace(t.path, result);
    console.log(`✓ 已修改: ${rel}`);
    for (const line of log) console.log(line);
  }

  console.log('\n修改完成。请重启 DSH 使更改生效。');
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
