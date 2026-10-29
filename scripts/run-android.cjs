// Android 构建的启动包装：先补齐环境变量，再走 run-tauri.cjs 同款修复。
//
// 为什么需要它：`tauri android build/init/dev` 每次都要求 JAVA_HOME、
// ANDROID_HOME、NDK_HOME 三个变量齐备（CLI 启动时会逐一检查）。写文档
// 让人每次手敲 export，不如在这里固化成「本机事实」：
//
//   · JDK 17   —— 复用 IntelliJ 装的 JBR（~/.jdks/jbr-17.0.14，带 javac；
//                 系统默认的 JDK 23 太新，Gradle 插件偶发不认）
//   · SDK/NDK  —— %LOCALAPPDATA%\Android\Sdk（NDK r27 = 27.0.12077973）
//   · cargo    —— 默认不在 PATH 里，这里顺手补上
//
// 用法（与 npm run tauri 一致，只是多了环境）：
//   npm run android -- build --debug --target aarch64
//   npm run android -- dev
//   npm run android -- init          # 已生成过，幂等
//
// 换机器 / 升级 NDK 时改下面的常量即可；已设置过的变量不覆盖。
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ANDROID_SDK = join(process.env.LOCALAPPDATA || homedir(), 'Android', 'Sdk')
const JDK17 = join(homedir(), '.jdks', 'jbr-17.0.14')
const NDK = join(ANDROID_SDK, 'ndk', '27.0.12077973')

if (!process.env.JAVA_HOME && existsSync(join(JDK17, 'bin', 'javac.exe'))) {
  process.env.JAVA_HOME = JDK17
}
if (!process.env.ANDROID_HOME && existsSync(ANDROID_SDK)) {
  process.env.ANDROID_HOME = ANDROID_SDK
}
// Tauri CLI 认 NDK_HOME；Gradle 侧认 ANDROID_NDK_HOME。两个都给。
if (!process.env.NDK_HOME && existsSync(NDK)) {
  process.env.NDK_HOME = NDK
  process.env.ANDROID_NDK_HOME = NDK
}
const cargoBin = join(homedir(), '.cargo', 'bin')
if (process.env.PATH && !process.env.PATH.includes(cargoBin)) {
  process.env.PATH = `${cargoBin};${process.env.PATH}`
}

process.argv[0] = 'node'
require('@tauri-apps/cli/tauri.js')
