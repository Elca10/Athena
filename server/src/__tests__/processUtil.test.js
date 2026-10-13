import { test } from "node:test";
import assert from "node:assert/strict";
import { knownWindowsCliDirs, withExtraPathDirs } from "../processUtil.js";

test("knownWindowsCliDirs: native installer, winget links, and npm global dirs", () => {
  const dirs = knownWindowsCliDirs({
    homedir: "C:\\Users\\friend",
    env: { LOCALAPPDATA: "C:\\Users\\friend\\AppData\\Local", APPDATA: "C:\\Users\\friend\\AppData\\Roaming" },
  });
  assert.deepEqual(dirs, [
    "C:\\Users\\friend\\.local\\bin",
    "C:\\Users\\friend\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Users\\friend\\AppData\\Roaming\\npm",
  ]);
});

test("knownWindowsCliDirs: falls back to the default AppData layout when env vars are missing", () => {
  const dirs = knownWindowsCliDirs({ homedir: "C:\\Users\\friend", env: {} });
  assert.equal(dirs[1], "C:\\Users\\friend\\AppData\\Local\\Microsoft\\WinGet\\Links");
  assert.equal(dirs[2], "C:\\Users\\friend\\AppData\\Roaming\\npm");
});

test("withExtraPathDirs: appends only dirs that exist and aren't already present", () => {
  const exists = new Set(["C:\\a", "C:\\b"]);
  const result = withExtraPathDirs("C:\\Windows;c:\\A\\", ["C:\\a", "C:\\b", "C:\\missing"], {
    existsFn: (d) => exists.has(d),
  });
  assert.equal(result, "C:\\Windows;c:\\A\\;C:\\b");
});

test("withExtraPathDirs: handles an empty or undefined PATH", () => {
  assert.equal(withExtraPathDirs(undefined, ["C:\\a"], { existsFn: () => true }), "C:\\a");
  assert.equal(withExtraPathDirs("", ["C:\\a"], { existsFn: () => true }), "C:\\a");
});

test("withExtraPathDirs: idempotent", () => {
  const once = withExtraPathDirs("C:\\Windows", ["C:\\a"], { existsFn: () => true });
  assert.equal(withExtraPathDirs(once, ["C:\\a"], { existsFn: () => true }), once);
});
