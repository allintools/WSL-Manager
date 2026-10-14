use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../agent-go");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    for arch in ["amd64", "arm64"] {
        let status = Command::new("go")
            .current_dir("../agent-go")
            .env("GOOS", "linux")
            .env("GOARCH", arch)
            .env("CGO_ENABLED", "0")
            .args(["build", "-trimpath", "-ldflags=-s -w", "-o"])
            .arg(out.join(format!("linuxdesk-agent-{arch}")))
            .arg(".")
            .status()
            .expect("Go is required to package the Linux desktop agent");
        assert!(status.success(), "Go agent build failed for {arch}");
    }
    tauri_build::build();
}
