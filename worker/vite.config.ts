import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)

/**
 * 把 pdf.js 的 cMap 与标准字体目录原样复制到构建产物里。
 *
 * 为什么需要：pdf.js 遇到 PDF 内嵌的 CJK 子集字体时要去 cMap 目录查映射，
 * 找不到就报 "Ensure that the cMapUrl API parameter is provided"，
 * 表现为页面上一片汉字变成空白。
 *
 * 这两个目录是「按文件名读取」的静态资源，不是 ES 模块，
 * 所以 `?url` 解析不了，只能整目录复制。
 */
const PDFJS_DIRS = ['cmaps', 'standard_fonts']

function pdfjsAssets(): Plugin {
  // 从 package.json 反推 pdfjs-dist 包根目录
  const pkgRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))

  const copyDir = (from: string, to: string): boolean => {
    if (!fs.existsSync(from)) return false
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name)
      const d = path.join(to, entry.name)
      if (entry.isDirectory()) copyDir(s, d)
      else fs.copyFileSync(s, d)
    }
    return true
  }

  let outDir = 'dist'

  return {
    name: 'pdfjs-assets',

    configResolved(config) {
      outDir = config.build.outDir
    },

    closeBundle() {
      let total = 0
      for (const dir of PDFJS_DIRS) {
        const n = copyDir(path.join(pkgRoot, dir), path.resolve(outDir, dir))
        total += n ? 1 : 0
      }
      // eslint-disable-next-line no-console
      console.log(`\n  pdf.js 静态资源：${total}/${PDFJS_DIRS.length} 个目录已复制到 ${outDir}/\n`)
    },

    configureServer(server) {
      // dev 模式直接从 node_modules 提供，省得改代码要等复制
      server.middlewares.use((req, res, next) => {
        for (const dir of PDFJS_DIRS) {
          const prefix = `/${dir}/`
          const url = req.url
          if (url?.startsWith(prefix)) {
            const file = path.join(pkgRoot, dir, decodeURIComponent(url.slice(prefix.length)))
            if (fs.existsSync(file) && fs.statSync(file).isFile()) {
              res.setHeader('Content-Type', 'application/octet-stream')
              fs.createReadStream(file).pipe(res)
              return
            }
          }
        }
        next()
      })
    },
  }
}

/**
 * 构建时间戳。
 *
 * 打包成 exe 之后，前端资源是被**编译进二进制**的——源码改了不重新打包，
 * exe 里跑的还是旧界面，而两边看起来一模一样，极易误判「功能没做」。
 * 把这个时间显示在界面上，「我手上这个 exe 是哪天的」就一眼可辨。
 */
const buildStamp = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})()

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  // 相对路径：产物放到子目录、U 盘或 file:// 下直接双击打开都能跑
  base: './',
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
})