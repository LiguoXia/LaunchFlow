fn main() {
    println!("cargo:rerun-if-env-changed=LAUNCHFLOW_UPDATE_URL");
    println!("cargo:rerun-if-env-changed=LAUNCHFLOW_UPDATE_PUBLIC_KEY");
    tauri_build::build()
}
