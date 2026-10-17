/// 桌面壳的全部逻辑。
///
/// 这个应用刻意做成「纯前端 + 零后端」：盖章、渲染、导出全部在 WebView 里完成，
/// 文件不上传。因此 Rust 侧不注册任何命令或插件——这既是安全上的选择，
/// 也让二进制体积维持在 10MB 量级。
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动印章工具失败");
}