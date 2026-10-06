// Builds kernel-rs to WebAssembly and copies it to wasm/ (committed, so the
// app runs without a Rust toolchain). Needs: rustup target add wasm32-unknown-unknown
import { execSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
execSync('cargo build --release --target wasm32-unknown-unknown --manifest-path kernel-rs/Cargo.toml', { cwd: root, stdio: 'inherit' });
const from = `${root}kernel-rs/target/wasm32-unknown-unknown/release/squishables_kernel.wasm`;
const to = `${root}wasm/squishables_kernel.wasm`;
copyFileSync(from, to);
console.log(`wasm/squishables_kernel.wasm  ${(statSync(to).size / 1024).toFixed(0)} KB`);
