import { startStudioServer } from "./server.js";
import { resolve, join, dirname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const root = resolve(process.argv[2] ?? process.env.INKOS_PROJECT_ROOT ?? process.cwd());
const port = parseInt(process.env.INKOS_STUDIO_PORT ?? "4567", 10);

// Find studio package root (2 levels up from src/api/ or dist/api/)
const studioRoot = resolve(__dirname, "../..");
const distDir = join(studioRoot, "dist");

function isNewerThan(sourcePath: string, targetPath: string): boolean {
  if (!existsSync(sourcePath)) return false;
  if (!existsSync(targetPath)) return true;
  return statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs;
}

function shouldRebuildFrontend(): boolean {
  const distIndex = join(distDir, "index.html");
  if (!existsSync(distIndex)) return true;
  const watched = [
    join(studioRoot, "src", "App.tsx"),
    join(studioRoot, "src", "components", "StudioModelPicker.tsx"),
    join(studioRoot, "src", "lib", "studio-model-picker.ts"),
    join(studioRoot, "src", "pages", "ChatPage.tsx"),
    join(studioRoot, "src", "pages", "ServiceListPage.tsx"),
    join(studioRoot, "index.html"),
    join(studioRoot, "vite.config.ts"),
  ];
  return watched.some((path) => isNewerThan(path, distIndex));
}

if (shouldRebuildFrontend()) {
  console.log("Building frontend (source newer than dist, or dist missing)...");
  try {
    execSync("npx vite build", { cwd: studioRoot, stdio: "inherit" });
  } catch {
    console.error("Failed to build frontend. Run 'cd packages/studio && pnpm build' manually.");
    process.exit(1);
  }
}

startStudioServer(root, port, { staticDir: distDir }).catch((e) => {
  console.error("Failed to start studio:", e);
  process.exit(1);
});
