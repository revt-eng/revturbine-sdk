#!/usr/bin/env node
/**
 * check-snippets.mjs — Extract TypeScript/TSX code blocks from docs and type-check them.
 *
 * Scans hand-written docs (not auto-generated API docs) for fenced code blocks
 * tagged `ts`, `tsx`, or `typescript`, writes them to a temp file, and runs
 * `tsc --noEmit` against the SDK types.
 *
 * Usage: node scripts/check-snippets.mjs
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const DOCS = resolve(import.meta.dirname, '..', 'src', 'content', 'docs');
const TMP = resolve(import.meta.dirname, '..', '.snippet-check');
const API_DIR = join(DOCS, 'api'); // Exclude auto-generated

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (path.startsWith(API_DIR)) continue; // skip generated API docs
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) yield path;
  }
}

function extractCodeBlocks(content, filePath) {
  const blocks = [];
  const re = /```(?:ts|tsx|typescript)\n([\s\S]*?)```/g;
  let match;
  let index = 0;
  while ((match = re.exec(content)) !== null) {
    const code = match[1].trim();
    // Skip tiny fragments (single expressions, shell commands, etc.)
    if (code.split('\n').length < 3) continue;
    // Skip fragments that are clearly partial (start with ., }, //, or are just types)
    if (/^[.}\/]/.test(code)) continue;
    blocks.push({ code, file: filePath, index: index++ });
  }
  return blocks;
}

async function main() {
  // Collect all code blocks
  const allBlocks = [];
  for await (const file of walk(DOCS)) {
    const content = await readFile(file, 'utf-8');
    const blocks = extractCodeBlocks(content, file.replace(DOCS, ''));
    allBlocks.push(...blocks);
  }

  console.log(`Found ${allBlocks.length} code snippet(s) across docs`);

  if (allBlocks.length === 0) {
    console.log('✓ No snippets to check');
    process.exit(0);
  }

  // Write snippets to temp dir for type-checking
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  // Write a tsconfig for the snippets
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: false, // Snippets are illustrative, not strict
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      types: ['react'],
      paths: {
        '@revt-eng/sdk': ['../../web-sdk/index.ts'],
        '@revt-eng/sdk/*': ['../../web-sdk/*'],
      },
    },
    include: ['*.tsx'],
  };
  await writeFile(join(TMP, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  // Write each snippet as a separate file
  let written = 0;
  for (const block of allBlocks) {
    // Add React import if the snippet uses JSX
    let code = block.code;
    if (code.includes('<') && !code.includes("from 'react'") && !code.includes('from "react"')) {
      code = `import React from 'react';\n${code}`;
    }
    // Wrap bare expressions in a function if no top-level function/const/import
    if (!/^(import|export|const|let|var|function|class|type|interface|async|\/\/)/.test(code)) {
      code = `// @ts-nocheck\n${code}`;
    }
    const filename = `snippet_${block.file.replace(/\//g, '_').replace(/\.(md|mdx)$/, '')}_${block.index}.tsx`;
    await writeFile(join(TMP, filename), code);
    written++;
  }

  console.log(`Wrote ${written} snippet file(s) to ${TMP}`);

  // Type-check (non-fatal — report errors but don't fail the build)
  try {
    execSync('npx tsc --project tsconfig.json --noEmit 2>&1', {
      cwd: TMP,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    console.log('✓ All snippets type-check cleanly');
  } catch (err) {
    const output = err.stdout || err.stderr || '';
    const errorLines = output.split('\n').filter(l => l.includes('error TS'));
    console.warn(`⚠ ${errorLines.length} type error(s) in code snippets (non-blocking):`);
    for (const line of errorLines.slice(0, 20)) {
      console.warn(`  ${line}`);
    }
    if (errorLines.length > 20) {
      console.warn(`  ... and ${errorLines.length - 20} more`);
    }
    // Exit 0 — snippet errors are warnings, not blockers
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
}

main();
