import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAppDataDir, appDataSubdirs, APP_NAME } from "../dataDir.js";

test("ATHENA_DATA_DIR override always wins, regardless of platform", () => {
  const dir = resolveAppDataDir(
    { ATHENA_DATA_DIR: "/tmp/scratch-athena" },
    "darwin",
    "/home/someone",
  );
  assert.equal(dir, "/tmp/scratch-athena");
});

test("macOS default is under Library/Application Support", () => {
  const dir = resolveAppDataDir({}, "darwin", "/Users/friend");
  assert.equal(dir, path.join("/Users/friend", "Library", "Application Support", APP_NAME));
});

test("Windows default uses APPDATA when set", () => {
  const dir = resolveAppDataDir(
    { APPDATA: "C:\\Users\\friend\\AppData\\Roaming" },
    "win32",
    "C:\\Users\\friend",
  );
  assert.equal(dir, path.join("C:\\Users\\friend\\AppData\\Roaming", APP_NAME));
});

test("Windows falls back to a same-shaped path if APPDATA is somehow unset", () => {
  const dir = resolveAppDataDir({}, "win32", "C:\\Users\\friend");
  assert.equal(dir, path.join("C:\\Users\\friend", "AppData", "Roaming", APP_NAME));
});

test("Linux default follows XDG_DATA_HOME", () => {
  const dir = resolveAppDataDir({ XDG_DATA_HOME: "/home/friend/.data" }, "linux", "/home/friend");
  assert.equal(dir, path.join("/home/friend/.data", "athena-studying"));
});

test("Linux falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
  const dir = resolveAppDataDir({}, "linux", "/home/friend");
  assert.equal(dir, path.join("/home/friend", ".local", "share", "athena-studying"));
});

test("appDataSubdirs names every subdir under the base", () => {
  const dirs = appDataSubdirs("/base");
  assert.equal(dirs.base, "/base");
  assert.equal(dirs.db, path.join("/base", "db"));
  assert.equal(dirs.content, path.join("/base", "content"));
  assert.equal(dirs.logs, path.join("/base", "logs"));
  assert.equal(dirs.updater, path.join("/base", "updater"));
});
