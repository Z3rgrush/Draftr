//! The desktop core. In this prototype it owns the project files on disk; the
//! story model and checks run in the TypeScript layer so the same code also
//! runs in a browser preview. Moving indexing into Rust is a later step.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
pub struct SceneFile {
    file: String,
    content: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProjectFiles {
    manifest: String,
    scenes: Vec<SceneFile>,
}

/// Documents/Margin, where new projects are created.
#[tauri::command]
fn projects_root(app: tauri::AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let root = docs.join("Margin");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

/// Scene file names come from the UI; refuse anything that could leave the scenes folder.
fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.ends_with(".md")
        && !name.contains(['/', '\\'])
        && !name.starts_with('.');
    if ok {
        Ok(name)
    } else {
        Err(format!("unsafe scene file name: {name}"))
    }
}

/// Write atomically: a temp file, then rename, so a crash never leaves half a scene.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_project(dir: String, files: ProjectFiles) -> Result<(), String> {
    let dir = PathBuf::from(dir);
    let scenes = dir.join("scenes");
    fs::create_dir_all(&scenes).map_err(|e| e.to_string())?;
    let mut keep = Vec::new();
    for s in &files.scenes {
        let name = safe_name(&s.file)?;
        let path = scenes.join(name);
        // Skip unchanged files so sync tools only see real edits.
        if fs::read_to_string(&path).ok().as_deref() != Some(s.content.as_str()) {
            write_atomic(&path, &s.content)?;
        }
        keep.push(name.to_string());
    }
    write_atomic(&dir.join("project.json"), &files.manifest)?;
    // Scenes that were deleted or renamed in the app go to a trash folder, not into the void.
    let trash = dir.join(".trash");
    for entry in fs::read_dir(&scenes).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") && !keep.contains(&name) {
            fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
            fs::rename(entry.path(), trash.join(&name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Write an export (e.g. the manuscript as Markdown) into the project folder's exports/.
#[tauri::command]
fn export_file(dir: String, name: String, content: String) -> Result<String, String> {
    let name = safe_name(&name)?;
    let out = PathBuf::from(dir).join("exports");
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let path = out.join(name);
    write_atomic(&path, &content)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn load_project(dir: String) -> Result<ProjectFiles, String> {
    let dir = PathBuf::from(dir);
    let manifest = fs::read_to_string(dir.join("project.json")).map_err(|e| format!("not a Margin project: {e}"))?;
    let mut scenes = Vec::new();
    if let Ok(rd) = fs::read_dir(dir.join("scenes")) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".md") {
                let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
                scenes.push(SceneFile { file: name, content });
            }
        }
    }
    Ok(ProjectFiles { manifest, scenes })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![projects_root, save_project, load_project, export_file])
        .run(tauri::generate_context!())
        .expect("error while running Margin");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_escapes() {
        assert!(safe_name("001-the-letter.md").is_ok());
        assert!(safe_name("../evil.md").is_err());
        assert!(safe_name("a/b.md").is_err());
        assert!(safe_name("notes.txt").is_err());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("margin-test-{}", std::process::id()));
        let files = ProjectFiles {
            manifest: "{\"sceneFiles\":[\"001-a.md\"]}".into(),
            scenes: vec![SceneFile { file: "001-a.md".into(), content: "---\nid: a\n---\nHello.\n".into() }],
        };
        save_project(dir.to_string_lossy().into(), files).unwrap();
        let back = load_project(dir.to_string_lossy().into()).unwrap();
        assert_eq!(back.scenes.len(), 1);
        assert_eq!(back.scenes[0].content, "---\nid: a\n---\nHello.\n");
        // A scene removed in the app moves to .trash on the next save.
        save_project(dir.to_string_lossy().into(), ProjectFiles { manifest: "{}".into(), scenes: vec![] }).unwrap();
        assert!(dir.join(".trash/001-a.md").exists());
        fs::remove_dir_all(dir).ok();
    }
}
