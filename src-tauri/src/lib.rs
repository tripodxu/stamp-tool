/// 桌面壳的全部逻辑。
///
/// 这个应用刻意做成「纯前端 + 零后端」：盖章、渲染、导出全部在 WebView 里完成，
/// 文件不上传。因此 Rust 侧不注册任何命令或插件——这既是安全上的选择，
/// 也让二进制体积维持在 10MB 量级。
///
/// `mobile_entry_point`：Android/iOS 构建时由它生成 JNI 入口（startApp 与
/// 生命周期符号）。缺了这个属性，编出的 .so 没有任何导出符号，Kotlin 侧的
/// external fun 全部落空——应用一启动就 UnsatisfiedLinkError 闪退。
/// cfg_attr 保证桌面构建完全不受影响。
#[cfg_attr(any(target_os = "android", target_os = "ios"), tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动印章工具失败");
}