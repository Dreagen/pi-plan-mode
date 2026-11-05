import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const MAX_SYMLINK_HOPS = 40;

/**
 * Normalise a path the way pi's built-in file tools do (unicode spaces, leading `@`,
 * `~` expansion, `file://` URLs) and resolve it against `cwd`. Does not touch the filesystem.
 */
export function resolveToolPath(input: string, cwd: string, home: string = homedir()): string {
    let p = input.replace(UNICODE_SPACES, " ");
    if (p.startsWith("@")) p = p.slice(1);
    if (p === "~") p = home;
    else if (p.startsWith("~/")) p = join(home, p.slice(2));
    if (/^file:\/\//.test(p)) p = fileURLToPath(p);
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Resolve every symlink in an absolute path, tolerating components that do not exist yet
 * (they are appended lexically). Dangling symlinks are followed to their target, so a link
 * pointing outside a directory is never mistaken for a path inside it.
 * Throws for unexpected filesystem errors (e.g. EACCES) and symlink loops.
 */
export function realpathAllowingMissing(absolutePath: string): string {
    const root = parse(absolutePath).root;
    const pending = absolutePath.slice(root.length).split(sep).filter(Boolean).reverse();
    let resolved = root;
    let hops = 0;
    while (pending.length > 0) {
        const part = pending.pop() as string;
        if (part === ".") continue;
        if (part === "..") {
            resolved = dirname(resolved);
            continue;
        }
        const candidate = join(resolved, part);
        let isLink = false;
        try {
            isLink = lstatSync(candidate).isSymbolicLink();
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            resolved = candidate;
            continue;
        }
        if (!isLink) {
            resolved = candidate;
            continue;
        }
        if (++hops > MAX_SYMLINK_HOPS) {
            throw Object.assign(new Error(`Too many symbolic links resolving ${absolutePath}`), { code: "ELOOP" });
        }
        const target = readlinkSync(candidate);
        if (isAbsolute(target)) resolved = parse(target).root;
        const targetParts = target.slice(parse(target).root.length).split(sep).filter(Boolean);
        for (let i = targetParts.length - 1; i >= 0; i--) pending.push(targetParts[i]);
    }
    return resolved;
}

/** True when `target` equals `directory` or lies inside it. Both must be absolute and normalised. */
export function isContained(target: string, directory: string): boolean {
    const rel = relative(directory, target);
    if (rel === "") return true;
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export type WriteCheck =
    | { allowed: true; resolved: string }
    | { allowed: false; reason: string; resolved?: string };

/**
 * Decide whether a write to `rawPath` is permitted. Symlinks are resolved on both the target
 * and the allowed directories before the containment check, so a link inside an allowed
 * directory does not grant access to its (external) destination unless that destination is
 * itself allowed.
 */
export function checkWriteTarget(
    rawPath: string,
    cwd: string,
    allowedDirectories: readonly string[],
    home: string = homedir(),
): WriteCheck {
    if (allowedDirectories.length === 0) {
        return { allowed: false, reason: "no writable directories are configured" };
    }
    let resolved: string;
    try {
        resolved = realpathAllowingMissing(resolveToolPath(rawPath, cwd, home));
    } catch (error) {
        return { allowed: false, reason: `the path could not be resolved safely (${(error as Error).message})` };
    }
    for (const directory of allowedDirectories) {
        let realDirectory: string;
        try {
            realDirectory = realpathAllowingMissing(directory);
        } catch {
            continue;
        }
        if (isContained(resolved, realDirectory)) return { allowed: true, resolved };
    }
    return { allowed: false, resolved, reason: "the target is outside every writable directory" };
}
