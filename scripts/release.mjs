import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 一键发布：重建 exe 并自动拷到目标位置。
 *
 * 为什么需要它：Tauri 把前端资源**编译进** exe，源码改了必须重新打包；
 * 而打包产物在 src-tauri/target/release/ 下又不能直接双击运行
 * （见 README-打包.md），得手工复制出去。这一步过去靠人记，
 * 漏一次就会出现「代码里明明有、exe 里却没有」。
 *
 * 用法：
 *   npm run release                     拷到桌面（默认）
 *   npm run release -- --out D:\x.exe   指定位置
 *   STAMP_EXE_OUT=D:\x.exe npm run release
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = path.join(ROOT, 'src-tauri', 'target', 'release', 'stamp-tool.exe');
const DEFAULT_OUT =
  process.env.STAMP_EXE_OUT || path.join(os.homedir(), 'Desktop', '印章工具.exe');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : DEFAULT_OUT;

console.log('[release] 开始打包（前端 + Rust）…');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tauri.cjs'), 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (!existsSync(BUILT)) {
  console.error('[release] 没找到构建产物：' + BUILT);
  process.exit(1);
}

copyFileSync(BUILT, out);
const bytes = readFileSync(out);
const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const size = (statSync(out).size / 1024 / 1024).toFixed(2);

console.log('');
console.log('[release] 完成');
console.log('  产物   ' + out);
console.log('  大小   ' + size + ' MB');
console.log('  sha256 ' + sha + '…');
console.log('  时间   ' + new Date().toLocaleString());
