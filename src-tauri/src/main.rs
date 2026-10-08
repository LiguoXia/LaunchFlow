#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(debug_assertions)]
    {
        let args: Vec<_> = std::env::args_os().collect();
        if let Some(index) = args.iter().position(|s| s == "--test-data-dir") {
            if let Some(path) = args.get(index + 1) {
                std::env::set_var("LAUNCHFLOW_TEST_DATA_DIR", path);
            }
        }
    }
    launchflow_desktop::run()
}
