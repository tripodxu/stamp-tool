// Tauri CLI 启动包装。
//
// 为什么需要它：@tauri-apps/cli 的入口 tauri.js 靠 process.argv[0] 判断
// 「当前是否由 node 启动」，以决定该不该剥离掉脚本路径：
//
//   const [bin, script, ...args] = process.argv
//   else if (/(nodejs|node|bun|electron)-?[0-9]*$/.test(binStem)) { ... }
//   else { args.unshift(bin) }          // ← 落到这里
//
// 在本机（DSH Desktop 宿主）里 process.argv[0] 是宿主 exe 的路径而不是
// node.exe，正则匹配不上，于是宿主路径被当成子命令塞进去：
//
//   error: unrecognized subcommand 'C:\...\DSH Desktop.exe'
//
// 这里把 argv[0] 还原成 node，再交给官方入口处理，其余行为完全沿用官方逻辑。
process.argv[0] = 'node'

require('@tauri-apps/cli/tauri.js')