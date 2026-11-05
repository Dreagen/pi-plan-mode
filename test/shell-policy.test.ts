import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkShellCommand, tokenize } from "../src/shell-policy.ts";

const allowed = (command: string, extras: string[][] = []) => checkShellCommand(command, extras).allowed;
const reason = (command: string, extras: string[][] = []) => {
    const result = checkShellCommand(command, extras);
    return result.allowed ? "" : result.reason;
};

describe("tokenize", () => {
    it("splits on spaces and tabs and honours quotes", () => {
        assert.deepEqual(tokenize(`rg 'a b'  "c d"\te`), ["rg", "a b", "c d", "e"]);
        assert.deepEqual(tokenize(`a"b c"d ''`), ["ab cd", ""]);
    });
    it("reports unterminated quotes", () => {
        assert.equal(tokenize(`echo "abc`), "unterminated quote");
    });
});

describe("allowed read-oriented commands", () => {
    for (const command of [
        "pwd",
        "ls",
        "ls -la plan/",
        "ls -1 -a --color=never src",
        "cat README.md",
        "cat -n src/a.ts src/b.ts",
        "head -n 20 file.txt",
        "head -20 file.txt",
        "head -n20 file.txt",
        "tail -n +5 file.txt",
        "wc -l a b",
        "stat -c %s file",
        "file -b --mime-type a.png",
        "tree -L 2 -a src",
        "rg TODO src",
        "rg -n -i --hidden -g '!node_modules' foo",
        "rg -e foo -e bar -C 2 src",
        "rg --files",
        "grep -rn foo src",
        "grep -n --include=x.ts foo -r .",
        "grep -C2 foo file",
        "grep -i 'hello world' file",
        "find . -name 'x.ts' -type f",
        "find src -maxdepth 2 -mtime -1 -print",
        "find . -name a -o -name b",
        "find -L . -type d -empty",
        "git status",
        "git status -sb",
        "git --no-pager log --oneline -n 5",
        "git log -5 --format=%H -- src/a.ts",
        "git log --since=2.weeks --author=nick",
        "git diff --stat HEAD^",
        "git diff HEAD~1 -- src",
        "git diff --cached --name-only",
        "git show HEAD:README.md",
        "git show --stat -U3 abc123",
        "git branch",
        "git branch -a -vv",
        "git branch --list 'feature/x'",
        "git branch --show-current",
        "git rev-parse --show-toplevel",
        "git rev-parse --abbrev-ref HEAD",
        "git ls-files -o --exclude-standard",
    ]) {
        it(`allows: ${command}`, () => assert.ok(allowed(command), reason(command)));
    }
});

describe("hard rejections", () => {
    const cases: Array<[string, string, RegExp]> = [
        ["chaining with ;", "ls; rm -rf x", /";"/],
        ["chaining with &&", "ls && rm x", /"&"/],
        ["background &", "ls & rm x", /"&"/],
        ["pipeline", "cat a | sh", /"\|"/],
        ["output redirection", "cat a > b", /">"/],
        ["append redirection", "cat a >> b", /">"/],
        ["input redirection", "cat < a", /"<"/],
        ["here-string", "cat <<< x", /"<"/],
        ["command substitution $()", "cat $(whoami)", /"\$"/],
        ["backtick substitution", "cat `whoami`", /`/],
        ["variable expansion", "cat $HOME/x", /"\$"/],
        ["$IFS trick", "cat${IFS}file", /"\$"/],
        ["subshell", "(ls)", /"\("/],
        ["brace expansion", "cat {a,b}", /"\{"/],
        ["glob star", "cat *", /"\*"/],
        ["glob question", "cat ?", /"\?"/],
        ["glob class", "cat [a]", /"\["/],
        ["backslash", "cat a\\ b", /"\\"/],
        ["newline separator", "ls\nrm x", /newline/],
        ["carriage return", "ls\rrm x", /newline/],
        ["NUL", "ls\u0000rm", /control/],
        ["quoted metachar in double quotes", 'cat "a;b"', /";"/],
        ["quoted substitution", 'cat "$(id)"', /"\$"/],
        ["tilde expansion", "cat ~/secret", /~/],
        ["tilde user expansion", "cat ~root/.ssh/id_rsa", /~/],
        ["comment trick", "ls #", /#/],
        ["empty command", "   ", /empty/],
        ["unterminated quote", `cat "a`, /quote/],
    ];
    for (const [name, command, pattern] of cases) {
        it(`rejects ${name}`, () => {
            assert.equal(allowed(command), false);
            assert.match(reason(command), pattern);
        });
    }
});

describe("executable allowlist", () => {
    for (const command of [
        "rm -rf x",
        "mv a b",
        "cp a b",
        "touch x",
        "mkdir x",
        "tee x",
        "sed -i s/a/b/ f",
        "awk 1 f",
        "echo hi",
        "printf x",
        "curl http://x",
        "bash -c ls",
        "sh script.sh",
        "env ls",
        "xargs ls",
        "sudo ls",
        "nice ls",
        "time ls",
        "FOO=bar ls",
        "/bin/ls",
        "./ls",
        "python3 x.py",
        "node x.js",
        "npm test",
        "dotnet build",
        "constructor",
        "__proto__",
        "toString",
    ]) {
        it(`rejects unknown command: ${command}`, () => assert.equal(allowed(command), false));
    }
});

describe("argument validation (bypass attempts)", () => {
    const rejected: Array<[string, RegExp?]> = [
        ["find . -exec rm {} +", /\{|-exec/],
        ["find . -exec ls x", /-exec/],
        ["find . -execdir ls x", /-execdir/],
        ["find . -ok ls x", /-ok/],
        ["find . -okdir ls x", /-okdir/],
        ["find . -delete", /-delete/],
        ["find . -fprint out.txt", /-fprint/],
        ["find . -fprint0 out.txt", /-fprint0/],
        ["find . -fprintf out.txt x", /-fprintf/],
        ["find . -fls out.txt", /-fls/],
        ["find . -name", /requires a value/],
        ["find . -constructor", /allowlist/],
        ["find . -name x stray", /unexpected/],
        ["rg --pre cmd foo", /--pre/],
        ["rg --pre=cmd foo", /--pre/],
        ["rg --pre-glob x foo", /--pre-glob/],
        ["rg -z foo", /-z/],
        ["rg --search-zip foo", /--search-zip/],
        ["rg --hostname-bin x foo", /--hostname-bin/],
        ["rg --files --null --pre x", /--pre/],
        ["grep -f patterns.txt x", /-f/],
        ["tail -f log", /-f/],
        ["tail -F log", /-F/],
        ["tail --follow log", /--follow/],
        ["file -C", /-C/],
        ["file -m magic x", /-m/],
        ["file -z x", /-z/],
        ["tree -o out.txt", /-o/],
        ["tree -ao out.txt", /-o/],
        ["tree --output=out.txt", /--output/],
        ["tree -R", /-R/],
        ["ls --constructor", /allowlist/],
        ["ls --color=never=x --all=1", /does not take a value/],
        ["git -c core.pager=sh log", /before the subcommand/],
        ["git -C /tmp log", /before the subcommand/],
        ["git --git-dir=/x log", /before the subcommand/],
        ["git --no-pager -c core.pager=x log", /before the subcommand/],
        ["git --exec-path=/x log", /before the subcommand/],
        ["git log --output=out.txt", /--output/],
        ["git log --out=out.txt", /--out=/],
        ["git diff --output=out.txt", /--output/],
        ["git show --output out.txt HEAD", /--output/],
        ["git diff --ext-diff", /--ext-diff/],
        ["git log --ext-diff", /--ext-diff/],
        ["git diff --ext=x", /--ext/],
        ["git diff --no-index a b", /--no-index/],
        ["git diff -O orderfile", /-O/],
        ["git log -c core.pager=x", /-c/],
        ["git log -C /tmp", /-C/],
        ["git branch newbranch", /creates a branch/],
        ["git branch -d old", /-d/],
        ["git branch -D old", /-D/],
        ["git branch -m a b", /-m/],
        ["git branch -c a b", /-c/],
        ["git branch --set-upstream-to=x", /--set-upstream-to/],
        ["git branch --edit-description", /--edit-description/],
        ["git push", /subcommand/],
        ["git commit -m x", /subcommand/],
        ["git checkout main", /subcommand/],
        ["git reset --hard", /subcommand/],
        ["git config user.name x", /subcommand/],
        ["git clean -fd", /subcommand/],
        ["git stash", /subcommand/],
        ["git fetch", /subcommand/],
        ["git remote add x y", /subcommand/],
        ["git tag v1", /subcommand/],
        ["git alias-that-runs-something", /subcommand/],
        ["git constructor", /subcommand/],
        ["git", /subcommand/],
        ["git rev-parse --parseopt", /--parseopt/],
        ["git ls-files --exclude-from=x", /--exclude-from/],
        ["git status --porcelain --constructor", /allowlist/],
    ];
    for (const [command, pattern] of rejected) {
        it(`rejects: ${command}`, () => {
            assert.equal(allowed(command), false);
            if (pattern) assert.match(reason(command), pattern);
        });
    }

    it("requires values for valued options", () => {
        assert.equal(allowed("head -n"), false);
        assert.equal(allowed("rg --glob"), false);
        assert.equal(allowed("git log --max-count 5"), false); // --x=VALUE form only for this option
    });

    it("stops option parsing at --", () => {
        assert.ok(allowed("git log -- --output"));
        assert.ok(allowed("rg -- --pre"));
    });
});

describe("allowedShellCommands extras", () => {
    it("permits an unknown executable by argv prefix", () => {
        assert.ok(allowed("dotnet --info", [["dotnet", "--info"]]));
        assert.ok(allowed("make -n all", [["make", "-n"]]));
        assert.equal(allowed("make all", [["make", "-n"]]), false);
        assert.equal(allowed("dotnet build", [["dotnet", "--info"]]), false);
    });

    it("permits a built-in executable only on an exact full-argv match", () => {
        assert.ok(allowed("git stash list", [["git", "stash", "list"]]));
        assert.equal(allowed("git stash list --output=x", [["git", "stash", "list"]]), false);
        assert.equal(allowed("git stash drop", [["git", "stash", "list"]]), false);
    });

    it("never loosens built-in argument rules through a prefix entry", () => {
        assert.equal(allowed("git log --output=x", [["git", "log"]]), false);
        assert.equal(allowed("find . -exec rm x", [["find", "."]]), false);
    });

    it("never overrides hard rejections", () => {
        assert.equal(allowed("make -n; rm x", [["make", "-n"]]), false);
        assert.equal(allowed("make -n > out", [["make", "-n"]]), false);
        assert.equal(allowed("make -n $(id)", [["make", "-n"]]), false);
        assert.equal(allowed("make -n\nrm x", [["make", "-n"]]), false);
    });

    it("ignores empty prefix entries", () => {
        assert.equal(allowed("rm x", [[]]), false);
    });
});
