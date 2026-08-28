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

import { readFile, writeFile, mkdir, access, constants, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(__dirname, '..', 'backups');
const MARKER = '[sandbox-escalation-fix]';

// ── 目标文件定位 ──────────────────────────────────────────────────────────────

function getDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (process.env.APPDATA) return join(process.env.APPDATA, 'dsh-desktop', 'harness');
  return join(process.env.USERPROFILE || '~', '.dsh');
}

async function findNodeModulesBase() {
  const dshHome = getDshHome();
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
    join(dshHome, 'node_modules', '@deepseek-ai'),
  ];
  for (const p of candidates) {
    try { await access(p, constants.R_OK | constants.W_OK); return p; } catch {}
  }
  const profilesDir = join(dshHome, 'profiles');
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(profilesDir, entry.name, 'node_modules', '@deepseek-ai');
      try { await access(candidate, constants.R_OK | constants.W_OK); return candidate; } catch {}
    }
  } catch {}
  throw new Error(`无法定位 @deepseek-ai 目录。DSH_HOME=${dshHome}`);
}

// ── 备份与恢复 ────────────────────────────────────────────────────────────────

async function backupFile(srcPath) {
  const hash = createHash('sha256').update(srcPath).digest('hex').slice(0, 12);
  const backupName = `${hash}_${encodeURIComponent(srcPath)}`;
  const backupPath = join(BACKUP_DIR, backupName);
  await mkdir(BACKUP_DIR, { recursive: true });
  try { await access(backupPath, constants.R_OK); return backupPath; } catch {}
  // 直接备份用户当前的文件（修改之前的状态）
  await copyFile(srcPath, backupPath);
  return backupPath;
}

async function restoreFile(srcPath) {
  const hash = createHash('sha256').update(srcPath).digest('hex').slice(0, 12);
  const backupName = `${hash}_${encodeURIComponent(srcPath)}`;
  const backupPath = join(BACKUP_DIR, backupName);
  try { await access(backupPath, constants.R_OK); } catch { return false; }
  await copyFile(backupPath, srcPath);
  return true;
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
    console.error('用法: node scripts/patch.js <apply|restore|status|debug>');
    process.exit(1);
  }

  const baseDir = await findNodeModulesBase();
  console.log(`@deepseek-ai 目录: ${baseDir}`);

  const targets = [
    { path: join(baseDir, 'dsh-sandbox', 'lib', 'index.js'), getOps: getOpsForSandbox },
    { path: join(baseDir, 'dsh-tool-pwsh', 'lib', 'index.js'), getOps: getOpsForPwsh },
    { path: join(baseDir, 'dsh-tool-bash', 'lib', 'index.js'), getOps: getOpsForBash },
    { path: join(baseDir, 'dsh-tool-fs', 'lib', 'index.js'), getOps: getOpsForFs },
  ];

  if (command === 'status') {
    for (const t of targets) {
      const hash = createHash('sha256').update(t.path).digest('hex').slice(0, 12);
      const backupName = `${hash}_${encodeURIComponent(t.path)}`;
      const backupPath = join(BACKUP_DIR, backupName);
      let hasBackup = false;
      try { await access(backupPath, constants.R_OK); hasBackup = true; } catch {}
      let exists = false;
      try { await access(t.path, constants.R_OK); exists = true; } catch {}
      const rel = t.path.split('@deepseek-ai\\')[1] || t.path;
      console.log(`${exists ? '✓' : '✗'} ${rel}  ${hasBackup ? '[有备份]' : '[无备份]'}`);
    }
    return;
  }

  if (command === 'check') {
    // 检查四个文件是否都包含 MARKER
    let allPatched = true;
    for (const t of targets) {
      try {
        await access(t.path, constants.R_OK);
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
      const rel = t.path.split('@deepseek-ai\\')[1] || t.path;
      console.log(restored ? `✓ 已恢复: ${rel}` : `⚠ 无备份跳过: ${rel}`);
    }
    return;
  }

  if (command === 'debug') {
    for (const t of targets) {
      const rel = t.path.split('@deepseek-ai\\')[1] || t.path;
      try { await access(t.path, constants.R_OK); } catch { console.log(`✗ 不存在: ${rel}`); continue; }
      const content = await readFile(t.path, 'utf-8');
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

  // apply
  for (const t of targets) {
    const rel = t.path.split('@deepseek-ai\\')[1] || t.path;
    try { await access(t.path, constants.R_OK); } catch { console.log(`✗ 不存在: ${rel}`); continue; }
    const original = await readFile(t.path, 'utf-8');
    await backupFile(t.path, rel);
    const ops = t.getOps();
    const { result, log } = applyOps(original, ops);
    await writeFile(t.path, result, 'utf-8');
    console.log(`✓ 已修改: ${rel}`);
    for (const line of log) console.log(line);
  }

  console.log('\n修改完成。请重启 DSH 使更改生效。');
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
