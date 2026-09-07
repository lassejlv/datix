// Compatibility entry point for tools invoking the former deployment checker.
// Validation and deployment now target the pinned Bun/Railway Docker image.
const result = Bun.spawn(['bun', 'run', 'deploy:check'], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await result.exited);
export {};
