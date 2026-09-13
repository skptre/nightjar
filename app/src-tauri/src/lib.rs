use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::process::Command;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

struct TrayMenuItems {
    sync_info: MenuItem<tauri::Wry>,
    posting_count: MenuItem<tauri::Wry>,
}

#[derive(Deserialize)]
struct SqlBatchStatement {
    query: String,
    values: Vec<JsonValue>,
}

const NIGHTJAR_DB: &str = "sqlite:nightjar.db";
const MAX_BATCH_STATEMENTS: usize = 10_000;
const MAX_SQL_BYTES: usize = 8 * 1024;
const MAX_BATCH_SQL_BYTES: usize = 16 * 1024 * 1024;
const MAX_VALUES_PER_STATEMENT: usize = 256;
const MAX_VALUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BATCH_VALUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_QUERY_VALUE_BYTES: usize = 8 * 1024 * 1024;

fn validated_value_size(value: &JsonValue) -> Result<usize, String> {
    match value {
        JsonValue::Null | JsonValue::Number(_) => Ok(0),
        JsonValue::String(value) => Ok(value.len()),
        JsonValue::Object(value) if value.len() == 1 => {
            let Some(blob) = value.get("blob").and_then(JsonValue::as_array) else {
                return Err("Database command contains an invalid value".to_string());
            };
            if blob
                .iter()
                .any(|byte| byte.as_u64().is_none_or(|byte| byte > u8::MAX.into()))
            {
                return Err("Database command contains an invalid blob".to_string());
            }
            blob.len()
                .checked_mul(5)
                .ok_or_else(|| "Database value is too large".to_string())
        }
        _ => Err("Database command contains an invalid value".to_string()),
    }
}

fn validate_sql_batch(statements: &[SqlBatchStatement]) -> Result<(), String> {
    if statements.is_empty() {
        return Err("Database batch must not be empty".to_string());
    }
    if statements.len() > MAX_BATCH_STATEMENTS {
        return Err("Database batch is too large".to_string());
    }

    let mut total_sql_bytes = 0usize;
    let mut total_value_bytes = 0usize;
    for statement in statements {
        let query = statement.query.trim();
        if query.is_empty() || query.len() > MAX_SQL_BYTES || query.contains(';') {
            return Err("Database batch contains an invalid statement".to_string());
        }
        let keyword = query
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if !matches!(
            keyword.as_str(),
            "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "ALTER" | "DROP"
        ) {
            return Err("Database batch contains a disallowed statement".to_string());
        }
        if statement.values.len() > MAX_VALUES_PER_STATEMENT {
            return Err("Database statement has too many values".to_string());
        }
        total_sql_bytes = total_sql_bytes
            .checked_add(query.len())
            .ok_or_else(|| "Database batch is too large".to_string())?;
        if total_sql_bytes > MAX_BATCH_SQL_BYTES {
            return Err("Database batch is too large".to_string());
        }

        for value in &statement.values {
            let value_bytes = validated_value_size(value)?;
            if value_bytes > MAX_VALUE_BYTES {
                return Err("Database value is too large".to_string());
            }
            total_value_bytes = total_value_bytes
                .checked_add(value_bytes)
                .ok_or_else(|| "Database batch is too large".to_string())?;
            if total_value_bytes > MAX_BATCH_VALUE_BYTES {
                return Err("Database batch is too large".to_string());
            }
        }
    }

    Ok(())
}

fn validate_sql_query(query: &str, values: &[JsonValue]) -> Result<(), String> {
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_SQL_BYTES || query.contains(';') {
        return Err("Database query is invalid".to_string());
    }
    if !query
        .split_whitespace()
        .next()
        .is_some_and(|keyword| keyword.eq_ignore_ascii_case("SELECT"))
    {
        return Err("Only read-only database queries are supported".to_string());
    }
    if values.len() > MAX_VALUES_PER_STATEMENT {
        return Err("Database query has too many values".to_string());
    }

    let mut total_value_bytes = 0usize;
    for value in values {
        let value_bytes = validated_value_size(value)?;
        if value_bytes > MAX_VALUE_BYTES {
            return Err("Database value is too large".to_string());
        }
        total_value_bytes = total_value_bytes
            .checked_add(value_bytes)
            .ok_or_else(|| "Database query is too large".to_string())?;
        if total_value_bytes > MAX_QUERY_VALUE_BYTES {
            return Err("Database query is too large".to_string());
        }
    }

    Ok(())
}

async fn run_sqlite_batch(
    pool: &sqlx::SqlitePool,
    statements: Vec<SqlBatchStatement>,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    for statement in statements {
        let mut query = sqlx::query(&statement.query);
        for value in statement.values {
            if value.is_null() {
                query = query.bind(None::<JsonValue>);
            } else if let Some(value) = value.as_str() {
                query = query.bind(value.to_owned());
            } else if let Some(value) = value.as_i64() {
                query = query.bind(value);
            } else if let Some(value) = value.as_u64() {
                let value = i64::try_from(value).map_err(|_| {
                    sqlx::Error::Protocol(
                        "Unsigned database value exceeds SQLite integer range".to_string(),
                    )
                })?;
                query = query.bind(value);
            } else if let Some(value) = value.as_f64() {
                query = query.bind(value);
            } else if let Some(blob) = value.get("blob").and_then(JsonValue::as_array) {
                let bytes = blob
                    .iter()
                    .filter_map(JsonValue::as_u64)
                    .map(|byte| byte as u8)
                    .collect::<Vec<_>>();
                query = query.bind(bytes);
            } else {
                return Err(sqlx::Error::Protocol(
                    "Unsupported database value".to_string(),
                ));
            }
        }
        query.execute(&mut *transaction).await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn run_sqlite_query(
    pool: &sqlx::SqlitePool,
    query_text: String,
    values: Vec<JsonValue>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, sqlx::Error> {
    let mut query = sqlx::query(&query_text);
    for value in values {
        if value.is_null() {
            query = query.bind(None::<JsonValue>);
        } else if let Some(value) = value.as_str() {
            query = query.bind(value.to_owned());
        } else if let Some(value) = value.as_i64() {
            query = query.bind(value);
        } else if let Some(value) = value.as_u64() {
            let value = i64::try_from(value).map_err(|_| {
                sqlx::Error::Protocol(
                    "Unsigned database value exceeds SQLite integer range".to_string(),
                )
            })?;
            query = query.bind(value);
        } else if let Some(value) = value.as_f64() {
            query = query.bind(value);
        } else if let Some(blob) = value.get("blob").and_then(JsonValue::as_array) {
            let bytes = blob
                .iter()
                .filter_map(JsonValue::as_u64)
                .map(|byte| byte as u8)
                .collect::<Vec<_>>();
            query = query.bind(bytes);
        } else {
            return Err(sqlx::Error::Protocol(
                "Unsupported database value".to_string(),
            ));
        }
    }

    let rows = query.fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            let mut result = serde_json::Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let raw = row.try_get_raw(index)?;
                let value = if raw.is_null() {
                    JsonValue::Null
                } else {
                    match raw.type_info().name() {
                        "TEXT" => JsonValue::String(row.try_get::<String, _>(index)?),
                        "REAL" => JsonValue::from(row.try_get::<f64, _>(index)?),
                        "INTEGER" | "NUMERIC" => JsonValue::from(row.try_get::<i64, _>(index)?),
                        "BOOLEAN" => JsonValue::from(row.try_get::<bool, _>(index)?),
                        "BLOB" => JsonValue::Array(
                            row.try_get::<Vec<u8>, _>(index)?
                                .into_iter()
                                .map(JsonValue::from)
                                .collect(),
                        ),
                        data_type => {
                            return Err(sqlx::Error::Protocol(format!(
                                "Unsupported SQLite result type: {data_type}"
                            )))
                        }
                    }
                };
                result.insert(column.name().to_string(), value);
            }
            Ok(result)
        })
        .collect()
}

#[tauri::command]
async fn execute_sql_batch(
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    db: String,
    statements: Vec<SqlBatchStatement>,
) -> Result<(), String> {
    if db != NIGHTJAR_DB {
        return Err("Unsupported database".to_string());
    }
    validate_sql_batch(&statements)?;

    let pool = {
        let databases = instances.0.read().await;
        match databases.get(NIGHTJAR_DB) {
            Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool.clone(),
            #[allow(unreachable_patterns)]
            Some(_) => return Err("Unsupported database".to_string()),
            None => return Err("Nightjar database is unavailable".to_string()),
        }
    };

    run_sqlite_batch(&pool, statements).await.map_err(|error| {
        #[cfg(debug_assertions)]
        eprintln!("Nightjar database batch failed: {error}");
        "Nightjar database batch failed".to_string()
    })
}

#[tauri::command]
async fn execute_sql_query(
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, String> {
    if db != NIGHTJAR_DB {
        return Err("Unsupported database".to_string());
    }
    validate_sql_query(&query, &values)?;

    let pool = {
        let databases = instances.0.read().await;
        match databases.get(NIGHTJAR_DB) {
            Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool.clone(),
            #[allow(unreachable_patterns)]
            Some(_) => return Err("Unsupported database".to_string()),
            None => return Err("Nightjar database is unavailable".to_string()),
        }
    };

    run_sqlite_query(&pool, query, values)
        .await
        .map_err(|error| {
            #[cfg(debug_assertions)]
            eprintln!("Nightjar database query failed: {error}");
            "Nightjar database query failed".to_string()
        })
}

#[tauri::command]
async fn close_nightjar_db(
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
) -> Result<(), String> {
    let pool = {
        let databases = instances.0.read().await;
        match databases.get(NIGHTJAR_DB) {
            Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool.clone(),
            #[allow(unreachable_patterns)]
            Some(_) => return Err("Unsupported database".to_string()),
            None => return Ok(()),
        }
    };
    pool.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        run_sqlite_batch, run_sqlite_query, validate_sql_batch, validate_sql_query,
        SqlBatchStatement,
    };
    use serde_json::json;
    use sqlx::Row;

    async fn memory_pool() -> sqlx::SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open")
    }

    #[test]
    fn sqlite_batch_commits_large_write_set() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            sqlx::query("CREATE TABLE rows (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&pool)
                .await
                .expect("table should be created");
            let statements = (0..1_000)
                .map(|index| SqlBatchStatement {
                    query: "INSERT INTO rows (id, value) VALUES ($1, $2)".to_string(),
                    values: vec![json!(format!("id-{index}")), json!("value")],
                })
                .collect();

            run_sqlite_batch(&pool, statements)
                .await
                .expect("batch should commit");

            let row = sqlx::query("SELECT COUNT(*) AS count FROM rows")
                .fetch_one(&pool)
                .await
                .expect("count should be readable");
            assert_eq!(row.get::<i64, _>("count"), 1_000);
        });
    }

    #[test]
    fn sqlite_batch_rolls_back_every_write_on_failure() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            sqlx::query("CREATE TABLE rows (id TEXT PRIMARY KEY)")
                .execute(&pool)
                .await
                .expect("table should be created");
            let statements = vec![
                SqlBatchStatement {
                    query: "INSERT INTO rows (id) VALUES ($1)".to_string(),
                    values: vec![json!("duplicate")],
                },
                SqlBatchStatement {
                    query: "INSERT INTO rows (id) VALUES ($1)".to_string(),
                    values: vec![json!("duplicate")],
                },
            ];

            assert!(run_sqlite_batch(&pool, statements).await.is_err());

            let row = sqlx::query("SELECT COUNT(*) AS count FROM rows")
                .fetch_one(&pool)
                .await
                .expect("count should be readable");
            assert_eq!(row.get::<i64, _>("count"), 0);
        });
    }

    #[test]
    fn sqlite_batch_rejects_transaction_control() {
        let statements = vec![SqlBatchStatement {
            query: "COMMIT".to_string(),
            values: vec![],
        }];

        assert!(validate_sql_batch(&statements).is_err());
    }

    #[test]
    fn sqlite_query_returns_typed_rows() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            sqlx::query("CREATE TABLE rows (id TEXT PRIMARY KEY, score INTEGER)")
                .execute(&pool)
                .await
                .expect("table should be created");
            sqlx::query("INSERT INTO rows (id, score) VALUES ('one', 42)")
                .execute(&pool)
                .await
                .expect("row should be inserted");

            let rows = run_sqlite_query(
                &pool,
                "SELECT id, score FROM rows WHERE id = $1".to_string(),
                vec![json!("one")],
            )
            .await
            .expect("query should succeed");
            assert_eq!(rows[0].get("id"), Some(&json!("one")));
            assert_eq!(rows[0].get("score"), Some(&json!(42)));
        });
    }

    #[test]
    fn sqlite_query_rejects_mutation_with_returning() {
        assert!(validate_sql_query("DELETE FROM rows RETURNING id", &[]).is_err());
    }
}

#[tauri::command]
fn update_tray_info(
    state: tauri::State<'_, Mutex<TrayMenuItems>>,
    last_sync: String,
    new_count: u32,
) -> Result<(), String> {
    let items = state.lock().map_err(|e| e.to_string())?;
    items
        .sync_info
        .set_text(format!("Last sync: {last_sync}"))
        .map_err(|e| e.to_string())?;
    items
        .posting_count
        .set_text(format!("New postings: {new_count}"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid job URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web URLs can be opened".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("rundll32");
        cmd.arg("url.dll,FileProtocolHandler").arg(parsed.as_str());
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(parsed.as_str());
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(parsed.as_str());
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open job URL: {error}"))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            update_tray_info,
            show_window,
            open_external_url,
            execute_sql_batch,
            execute_sql_query,
            close_nightjar_db
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    window.set_icon(icon.clone())?;
                }
            }

            // System tray menu items
            let open = MenuItem::with_id(app, "open", "Open Nightjar", true, None::<&str>)?;
            let sync_info =
                MenuItem::with_id(app, "sync_info", "Last sync: never", false, None::<&str>)?;
            let posting_count =
                MenuItem::with_id(app, "posting_count", "New postings: 0", false, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &sync_info,
                    &posting_count,
                    &PredefinedMenuItem::separator(app)?,
                    &sync_now,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            // Store dynamic menu items for later updates from frontend
            app.manage(Mutex::new(TrayMenuItems {
                sync_info: sync_info.clone(),
                posting_count: posting_count.clone(),
            }));

            // Build system tray
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nightjar")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "sync_now" => {
                        let _ = app.emit("trigger-sync", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Let the normal close event tear down the WebView before app exit.
            if let Some(window) = app.get_webview_window("main") {
                // Auto-launch with --minimized: start hidden, tray only
                if std::env::args().any(|a| a == "--minimized") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
