// 一条命令产出可安装的 APK：npm run apk
//
// 为什么存在：本机两个环境坑让标准路径 `tauri android build` 走不通——
//   ① Windows 未开开发者模式 → CLI 把 .so 软链进 jniLibs 时失败；
//   ② 绕开 CLI 直接调 Gradle 又会漏掉「CLI 本该做的拷贝」（.so 进 jniLibs、
//     dist 进 assets），首版 APK 正是漏了 assets（1.98MB、装上闪退）。
// 这个脚本把整条链固化下来，顺带容忍 CLI 在软链一步的预期失败：
//
//   1. vite build                        → dist/
//   2. tauri CLI android build（cargo 交叉编译，环境由 CLI 注入）
//                                        → target/aarch64-linux-android/release/*.so
//                                        （随后 CLI 死在符号链接——预期内，继续）
//   3. cp .so   → gen/android/app/src/main/jniLibs/arm64-v8a/
//   4. cp dist/ → gen/android/app/src/main/assets/   ← 闪退就是漏了这步
//   5. gradlew assembleArm64Release（-x rust 任务）
//   6. zipalign + apksigner（debug keystore）→ dist-android/stamp-tool-arm64.apk
//
// 开了开发者模式的机器不需要它：直接 npm run android -- build --apk --target aarch64。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC_TAURI = join(ROOT, 'src-tauri')
const GEN_ANDROID = join(SRC_TAURI, 'gen', 'android')
const ANDROID_SDK = join(process.env.LOCALAPPDATA || homedir(), 'Android', 'Sdk')
const JAVA_HOME = join(homedir(), '.jdks', 'jbr-17.0.14')
const CARGO_BIN = join(homedir(), '.cargo', 'bin')
const BT = join(ANDROID_SDK, 'build-tools', '34.0.0')
const OUT = join(ROOT, 'dist-android', 'stamp-tool-arm64.apk')

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME: ANDROID_SDK,
  NDK_HOME: join(ANDROID_SDK, 'ndk', '27.0.12077973'),
  PATH: `${CARGO_BIN};${process.env.PATH}`,
}

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env, ...opts })
  return r.status === 0
}

// ---- 1. 前端 ----
if (!run('npm', ['run', 'build'], { cwd: ROOT })) process.exit(1)

// ---- 2. Rust 交叉编译（借 CLI 注入的 NDK 环境；软链失败是预期的） ----
const cli = spawnSync('node', ['scripts/run-android.cjs', 'android', 'build', '--apk', '--target', 'aarch64'], {
  stdio: 'pipe', shell: true, env, cwd: ROOT,
})
const cliOut = `${cli.stdout ?? ''}${cli.stderr ?? ''}`
const soPath = join(SRC_TAURI, 'target', 'aarch64-linux-android', 'release', 'libstamp_tool_lib.so')
if (!existsSync(soPath)) {
  console.error(cliOut.slice(-3000))
  console.error('\n.so 没编出来（不是软链问题），看上面的报错')
  process.exit(1)
}
if (cli.status !== 0) {
  console.log(`(CLI 退出码 ${cli.status}：${/symbolic link/i.test(cliOut) ? '符号链接一步的预期失败，.so 已就绪，继续' : '非预期失败，但 .so 存在——继续，若后面 Gradle 报错请回头看这段输出'})`)
}

// ---- 3+4. 手工补齐 CLI 没做完的两份拷贝 ----
cpSync(soPath, join(GEN_ANDROID, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a', 'libstamp_tool_lib.so'))
const assetsDir = join(GEN_ANDROID, 'app', 'src', 'main', 'assets')
rmSync(assetsDir, { recursive: true, force: true }) // 先清：旧的带 hash 文件名会越积越多
cpSync(join(ROOT, 'dist'), assetsDir, { recursive: true })
console.log('\n已拷贝：.so → jniLibs；dist → assets（漏这步的 APK 会闪退）')

// ---- 5. Gradle 打包 ----
const gradlew = join(GEN_ANDROID, 'gradlew.bat')
if (!run(`"${gradlew}"`, [
  '--no-daemon',
  '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64',
  '-x', 'rustBuildArm64Release', '-x', 'rustBuildUniversalRelease',
  'assembleArm64Release',
], { cwd: GEN_ANDROID })) process.exit(1)

// ---- 6. 对齐 + 签名 ----
const unsigned = join(GEN_ANDROID, 'app', 'build', 'outputs', 'apk', 'arm64', 'release', 'app-arm64-release-unsigned.apk')
mkdirSync(join(ROOT, 'dist-android'), { recursive: true })
rmSync(OUT, { force: true }); rmSync(`${OUT}.idsig`, { force: true })
if (!run(`"${join(BT, 'zipalign.exe')}"`, ['-f', '-p', '4', `"${unsigned}"`, `"${OUT}"`])) process.exit(1)
if (!run(`"${join(BT, 'apksigner.bat')}"`, [
  'sign', '--ks', `"${join(homedir(), '.android', 'debug.keystore')}"`,
  '--ks-pass', 'pass:android', '--key-pass', 'pass:android', `"${OUT}"`,
])) process.exit(1)

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(2)
console.log(`\n完成：dist-android\\stamp-tool-arm64.apk（${mb} MB，arm64-v8a，debug 签名）`)
console.log('装机：adb install -r dist-android\\stamp-tool-arm64.apk')
