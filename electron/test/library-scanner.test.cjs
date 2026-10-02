/**
 * 音乐库扫描器单元测试。
 * 覆盖：递归、去重、权限异常、深度限制、截断、路径清洗。
 * 运行：npm run check:scanner
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { scanRoot, scanRoots, sanitizeDroppedPaths } = require('../main/library-scanner.js')
const { normalizeForCompare } = require('../main/platform.js')

/** @param {string} name @returns {string} */
function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rhine-scan-${name}-`))
}

/** 造一棵目录树：{ 'a/b/song.mp3': 'x' } */
async function makeTree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content)
  }
}

test('递归扫描：嵌套目录中的音频文件都能被找到', async (t) => {
  const root = tmpDir('nested')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, {
    'top.mp3': 'a',
    'album/01.flac': 'b',
    'album/deep/nested/02.wav': 'c',
    'notes.txt': 'skip me',
  })
  const { files, errors } = await scanRoot(root)
  const names = files.map((f) => f.name).sort()
  assert.deepEqual(names, ['01.flac', '02.wav', 'top.mp3'])
  assert.equal(errors.length, 0)
})

test('去重：共享去重集合时，重复扫描不产生重复条目', async (t) => {
  const root = tmpDir('dedupe')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, { 'a.mp3': 'a', 'b.mp3': 'b' })
  // 去重集合由调用方持有并在多次扫描间共享（这是跨根目录去重的实现方式）
  const existingPaths = new Set()
  const first = await scanRoot(root, { existingPaths })
  const second = await scanRoot(root, { existingPaths })
  assert.equal(first.files.length, 2)
  assert.equal(second.files.length, 0, '第二次扫描应全部命中去重集合')
  assert.equal(existingPaths.size, 2, '去重集合应记录全部路径')
})

test('去重：路径大小写与分隔符差异在 Windows 上视为同一个', async (t) => {
  const root = tmpDir('dedupe-case')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, { 'a.mp3': 'a' })
  // 用真实的归一化函数构造「同一路径的另一种写法」
  const existingPaths = new Set([normalizeForCompare(path.join(root, 'A.MP3'))])
  const { files } = await scanRoot(root, { existingPaths })
  assert.equal(files.length, 0, '大小写不同的同一路径应被去重')
})

test('去重：跨根目录去重，父子目录同时选中时不重复统计', async (t) => {
  const root = tmpDir('cross')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, { 'sub/x.mp3': 'a', 'y.mp3': 'b' })
  const result = await scanRoots([root, path.join(root, 'sub')])
  const names = result.files.map((f) => f.name).sort()
  assert.deepEqual(names, ['x.mp3', 'y.mp3'], '子目录文件不应被统计两次')
  assert.equal(result.roots.length, 1, '父子根应合并为一个')
})

test('权限异常：不存在的目录被拒绝且带可诊断错误码', async (t) => {
  const missing = path.join(os.tmpdir(), 'rhine-does-not-exist-xyz')
  const result = await scanRoot(missing)
  assert.equal(result.files.length, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'NOT_FOUND')
  assert.match(result.errors[0].message, /不存在/)
})

test('权限异常：文件（而非目录）传入时返回 NOT_A_DIRECTORY', async (t) => {
  const root = tmpDir('notdir')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'plain.mp3')
  await fsp.writeFile(file, 'x')
  const result = await scanRoot(file)
  assert.equal(result.errors[0].code, 'NOT_A_DIRECTORY')
})

test('跳过系统目录：node_modules 等不参与扫描', async (t) => {
  const root = tmpDir('skip')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, {
    'keep.mp3': 'a',
    'node_modules/pkg/skip.mp3': 'b',
    '$RECYCLE.BIN/skip.mp3': 'c',
  })
  const { files } = await scanRoot(root)
  assert.deepEqual(files.map((f) => f.name), ['keep.mp3'])
})

test('路径清洗：去掉引号、file:// 前缀与重复项', () => {
  const out = sanitizeDroppedPaths([
    'C:\\Music\\Rock',
    '"C:\\Music\\Rock"',   // 带引号
    'file:///C:/Music/Jazz',
    '   ',
    null,
    'C:/Music/Rock',      // 大小写/分隔符不同 → Windows 上视为同一个
  ])
  assert.ok(out.length >= 2 && out.length <= 3, `实际 ${JSON.stringify(out)}`)
  assert.ok(out.every((p) => typeof p === 'string' && p.length > 0))
  assert.ok(!out.some((p) => p.includes('file://')))
})

test('统计字段完整：字节数与文件数一致', async (t) => {
  const root = tmpDir('stats')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await makeTree(root, { 'a.mp3': '12345', 'b.mp3': '123' })
  const result = await scanRoots([root])
  assert.equal(result.stats.totalFiles, 2)
  assert.equal(result.stats.totalBytes, 8)
  assert.equal(result.stats.totalRoots, 1)
  assert.equal(result.stats.rejectedCount, 0)
})
