fn main() {
    println!("cargo:rerun-if-changed=migrations");
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let mut files: Vec<_> = std::fs::read_dir(root.join("migrations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect();
    files.sort();
    let entries: Vec<_> = files
        .iter()
        .map(|path| {
            format!(
                "({:?},include_str!({:?}))",
                path.file_name().unwrap().to_str().unwrap(),
                path.to_str().unwrap()
            )
        })
        .collect();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("migrations.rs");
    std::fs::write(
        out,
        format!("const BUNDLED: &[(&str,&str)] = &[{}];", entries.join(",")),
    )
    .unwrap();
}
