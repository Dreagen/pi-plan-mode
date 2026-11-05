import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create a throwaway directory (symlink-resolved so assertions are stable on macOS). */
export function makeTempDir(prefix = "plan-mode-test-"): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function writeFile(path: string, content = ""): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
