import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveOpenCodeLocalHomeDir(env: Record<string, string>): string {
  const envHome = nonEmpty(env.HOME);
  if (envHome && path.isAbsolute(envHome) && !envHome.startsWith("/paperclip")) {
    return path.resolve(envHome);
  }
  try {
    const userHome = nonEmpty(os.userInfo().homedir);
    if (userHome) return path.resolve(userHome);
  } catch {
    // Fall back to os.homedir() when the current UID cannot be resolved.
  }
  return path.resolve(os.homedir());
}

export function normalizeOpenCodeLocalEnv(env: Record<string, string>): Record<string, string> {
  const home = resolveOpenCodeLocalHomeDir(env);
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"),
    XDG_DATA_HOME: nonEmpty(env.XDG_DATA_HOME) ?? path.join(home, ".local", "share"),
    XDG_STATE_HOME: nonEmpty(env.XDG_STATE_HOME) ?? path.join(home, ".local", "state"),
  };
}

function resolveXdgConfigHome(env: Record<string, string>): string {
  return normalizeOpenCodeLocalEnv(env).XDG_CONFIG_HOME;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const normalizedEnv = normalizeOpenCodeLocalEnv(input.env);
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: normalizedEnv,
      notes: [],
      cleanup: async () => {},
    };
  }
  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: normalizedEnv,
      notes: [],
      cleanup: async () => {},
    };
  }
  const sourceConfigDir = path.join(resolveXdgConfigHome(normalizedEnv), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const nextConfig = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...normalizedEnv,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes: [
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    ],
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
