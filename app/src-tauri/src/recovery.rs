use tauri::Manager;

fn recovery_name(reason: &str) -> Result<&'static str, String> {
    match reason {
        "daily" => Ok("workspace-daily.json"),
        "before-update" => Ok("workspace-before-update.json"),
        "before-restore" => Ok("workspace-before-restore.json"),
        _ => Err("Unknown recovery copy".into()),
    }
}

#[tauri::command]
pub async fn save_recovery_copy(app: tauri::AppHandle, content: String, reason: String) -> Result<String, String> {
    let name = recovery_name(&reason)?;
    if content.len() > 60 * 1024 * 1024 { return Err("Recovery copy is too large".into()); }
    let value: serde_json::Value = serde_json::from_str(&content).map_err(|_| "Invalid recovery copy")?;
    if value["format"] != "nightjar-workspace" || value["version"] != 1 { return Err("Invalid recovery copy".into()); }
    let directory = app.path().app_local_data_dir().map_err(|_| "Recovery folder unavailable")?.join("backups");
    std::fs::create_dir_all(&directory).map_err(|_| "Could not create recovery folder")?;
    let target = directory.join(name);
    // Unique temporary files prevent overlapping autosave and manual backup writes.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "System clock error")?.as_nanos();
    let temporary = directory.join(format!("{name}.{stamp}.tmp"));
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "Could not create recovery copy")?;
    let result = file.write_all(content.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    if result.is_err() { let _ = std::fs::remove_file(&temporary); return Err("Could not save recovery copy".into()); }
    if std::fs::rename(&temporary, &target).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("Could not finish recovery copy".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn load_recovery_copy(app: tauri::AppHandle, reason: String) -> Result<String, String> {
    let name = recovery_name(&reason)?;
    let path = app.path().app_local_data_dir().map_err(|_| "Recovery folder unavailable")?.join("backups").join(name);
    if std::fs::metadata(&path).map_err(|_| "No recovery copy is available yet")?.len() > 60 * 1024 * 1024 { return Err("Recovery copy is too large".into()); }
    std::fs::read_to_string(path).map_err(|_| "Could not read recovery copy".into())
}

#[tauri::command]
pub async fn backup_before_migration(app: tauri::AppHandle, instances: tauri::State<'_, tauri_plugin_sql::DbInstances>, version: u32, settings: String) -> Result<(), String> {
    if settings.len() > 4 * 1024 * 1024 { return Err("Preferences are too large".into()); }
    let directory = app.path().app_local_data_dir().map_err(|_| "Recovery folder unavailable")?.join("backups");
    std::fs::create_dir_all(&directory).map_err(|_| "Could not create recovery folder")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "System clock error")?.as_nanos();
    let path = directory.join(format!("before-migration-v{version}-{stamp}.sqlite"));
    let pool = {
        let databases = instances.0.read().await;
        match databases.get("sqlite:nightjar.db") {
            Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool.clone(),
            _ => return Err("Database unavailable for recovery backup".into()),
        }
    };
    sqlx::query("VACUUM INTO ?").bind(path.to_string_lossy().as_ref()).execute(&pool).await.map_err(|_| "Database recovery backup failed; migration cancelled")?;
    std::fs::write(path.with_extension("settings.json"), settings).map_err(|_| "Preferences recovery backup failed; migration cancelled")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn recovery_paths_are_fixed() {
        for path in ["../secret", "C:\\secret", "", "daily/../../file"] { assert!(super::recovery_name(path).is_err()); }
        assert_eq!(super::recovery_name("daily").unwrap(), "workspace-daily.json");
    }
}

#[tauri::command]
pub async fn clear_recovery_copies(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app.path().app_local_data_dir().map_err(|_| "Recovery folder unavailable")?.join("backups");
    if !directory.exists() { return Ok(()); }
    for entry in std::fs::read_dir(directory).map_err(|_| "Could not read recovery folder")? {
        let entry = entry.map_err(|_| "Could not read recovery copy")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.starts_with("workspace-") || name.starts_with("before-migration-v"))
            && entry.file_type().map_err(|_| "Could not inspect recovery copy")?.is_file() {
            std::fs::remove_file(entry.path()).map_err(|_| "Could not remove recovery copy")?;
        }
    }
    Ok(())
}
