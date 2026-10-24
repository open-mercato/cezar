fn main() {
    // `update_cezar_command` is the one command the cockpit page may invoke (the title strip's
    // "Update cezar" pill on cockpits that predate the desktop-aware build); listing it here
    // generates its `allow-update-cezar-command` permission for capabilities/default.json.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["update_cezar_command", "restart_app", "show_versions_menu", "send_error_report", "connect_server"])),
    )
    .expect("failed to run tauri-build");
}
