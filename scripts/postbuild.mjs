import { chmod } from "node:fs/promises";

try {
  await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
} catch (error) {
  // Windows may not expose POSIX mode bits. npm still creates a .cmd shim.
  if (process.platform !== "win32") throw error;
}
