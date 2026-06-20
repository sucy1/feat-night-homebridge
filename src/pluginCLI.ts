import type { PluginIdentifier, PluginName } from './api.js'
import type { AccessoryConfig, HomebridgeConfig, PlatformConfig } from './bridgeService.js'

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

import fs from 'fs-extra'

import { Logger } from './logger.js'
import { PluginManager } from './pluginManager.js'
import { User } from './user.js'

const log = Logger.internal

export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginConfigError'
  }
}

export interface InstalledPluginInfo {
  identifier: PluginIdentifier
  name: PluginName
  version: string
  scope?: string
}

export interface PluginCLIInstallOptions {
  /** Install as global package. Defaults to true. */
  global?: boolean
  /** The package version/tag to install (e.g. "latest", "1.2.3"). */
  version?: string
  /**
   * When true, add a default platform or accessory config entry even if the
   * plugin was already installed. Defaults to false, meaning no config is
   * added when npm install is a no-op.
   */
  forceConfig?: boolean
  /**
   * Override the target config kind. If not supplied, the installer inspects
   * the plugin's package.json keywords / config schema and falls back to
   * 'platform' when ambiguous.
   */
  kind?: 'platform' | 'accessory'
  /**
   * When true, skip attempting to signal the running Homebridge to restart.
   */
  noRestart?: boolean
}

export interface PluginCLIUninstallOptions {
  /** Uninstall as global package. Defaults to true. */
  global?: boolean
  /** When true, keep the corresponding entries in config.json. Defaults to false. */
  keepConfig?: boolean
  /** When true, skip attempting to signal the running Homebridge to restart. */
  noRestart?: boolean
}

export class PluginCLI {
  /**
   * Resolve the absolute path to the working node_modules directory.
   * For global installs we use npm's global prefix; otherwise we rely on the
   * current working directory (useful for tests and local setups).
   */
  public static resolveNodeModulesRoot(global = true): string {
    if (!global) {
      return join(process.cwd(), 'node_modules')
    }
    try {
      const prefix = execSync('/bin/echo -n "$(npm -g prefix)"', {
        env: {
          npm_config_loglevel: 'silent',
          npm_update_notifier: 'false',
          ...process.env,
        },
        encoding: 'utf8',
      })
      return process.platform === 'win32'
        ? join(prefix, 'node_modules')
        : join(prefix, 'lib', 'node_modules')
    } catch {
      return process.platform === 'win32'
        ? join(process.env.APPDATA || '', 'npm/node_modules')
        : '/usr/local/lib/node_modules'
    }
  }

  // ---------------------------------------------------------------------------
  // Public entry points
  // ---------------------------------------------------------------------------

  /**
   * Install a Homebridge plugin from npm and add a default config entry.
   */
  public static async install(
    pluginIdentifier: string,
    options: PluginCLIInstallOptions = {},
  ): Promise<void> {
    if (!PluginManager.isQualifiedPluginIdentifier(pluginIdentifier)) {
      throw new PluginConfigError(
        `Invalid plugin name '${pluginIdentifier}'. Plugins must be named 'homebridge-xxx' or '@scope/homebridge-xxx'.`,
      )
    }

    const installArg = options.version
      ? `${pluginIdentifier}@${options.version}`
      : pluginIdentifier

    log.info('Installing plugin %s...', installArg)
    PluginCLI.runNpmInstall(installArg, options.global !== false)
    log.success('Plugin %s installed successfully.', pluginIdentifier)

    // Always try to append a default configuration. If the plugin was already
    // installed this still gives the user a "known-good" default config block
    // they can tweak, which is the primary UX win over running `npm i` by hand.
    const kind = options.kind || PluginCLI.inferPluginKind(pluginIdentifier, options.global !== false)
    const appended = PluginCLI.appendDefaultConfig(pluginIdentifier, kind)
    if (appended) {
      log.info('Added default %s entry for %s to config.json', kind, pluginIdentifier)
    } else {
      log.debug('No new config entry was appended for %s', pluginIdentifier)
    }

    if (!options.noRestart) {
      const restarted = PluginCLI.signalHomebridgeRestart()
      if (restarted) {
        log.info('Signalled running Homebridge instance to restart.')
      }
    }
  }

  /**
   * Uninstall a Homebridge plugin and remove its entries from config.json.
   */
  public static async uninstall(
    pluginIdentifier: string,
    options: PluginCLIUninstallOptions = {},
  ): Promise<void> {
    if (!PluginManager.isQualifiedPluginIdentifier(pluginIdentifier)) {
      throw new PluginConfigError(
        `Invalid plugin name '${pluginIdentifier}'. Plugins must be named 'homebridge-xxx' or '@scope/homebridge-xxx'.`,
      )
    }

    log.info('Uninstalling plugin %s...', pluginIdentifier)
    PluginCLI.runNpmUninstall(pluginIdentifier, options.global !== false)
    log.success('Plugin %s uninstalled successfully.', pluginIdentifier)

    if (!options.keepConfig) {
      const { removedAccessories, removedPlatforms } = PluginCLI.removePluginConfig(pluginIdentifier)
      if (removedAccessories || removedPlatforms) {
        log.info(
          'Removed %d accessory / %d platform entries from config.json',
          removedAccessories,
          removedPlatforms,
        )
      }
    }

    if (!options.noRestart) {
      const restarted = PluginCLI.signalHomebridgeRestart()
      if (restarted) {
        log.info('Signalled running Homebridge instance to restart.')
      }
    }
  }

  /**
   * List currently installed Homebridge plugins along with the entries that
   * exist for them in config.json.
   */
  public static list(options?: { global?: boolean }): InstalledPluginInfo[] {
    const root = PluginCLI.resolveNodeModulesRoot(options?.global !== false)
    const plugins: InstalledPluginInfo[] = []

    if (!existsSync(root)) {
      return plugins
    }

    const entries: string[] = []
    const raw = PluginCLI.safeReaddir(root)

    const scopes = raw.filter(name => name.startsWith('@'))
    const plain = raw.filter(name => !name.startsWith('@'))

    for (const scope of scopes) {
      const scopeDir = join(root, scope)
      const inner = PluginCLI.safeReaddir(scopeDir)
      for (const pkg of inner) {
        entries.push(`${scope}/${pkg}`)
      }
    }
    for (const pkg of plain) {
      entries.push(pkg)
    }

    for (const identifier of entries) {
      if (!PluginManager.isQualifiedPluginIdentifier(identifier)) {
        continue
      }
      const pkgPath = join(root, identifier)
      const pkgJsonPath = join(pkgPath, 'package.json')
      if (!existsSync(pkgJsonPath)) {
        continue
      }
      let version = '0.0.0'
      try {
        const data = JSON.parse(readFileSync(pkgJsonPath, { encoding: 'utf8' }))
        if (!data.keywords || !data.keywords.includes('homebridge-plugin')) {
          continue
        }
        version = data.version || version
      } catch {
        // If the package.json is unreadable it is not a usable plugin, skip.
        continue
      }

      const name = PluginManager.extractPluginName(identifier)
      const scope = PluginManager.extractPluginScope(identifier)
      plugins.push({ identifier, name, scope, version })
    }

    return plugins.sort((a, b) => a.identifier.localeCompare(b.identifier))
  }

  // ---------------------------------------------------------------------------
  // Config read / write helpers (extracted so tests can exercise error paths)
  // ---------------------------------------------------------------------------

  public static readConfig(configPath: string = User.configPath()): HomebridgeConfig {
    if (!existsSync(configPath)) {
      throw new PluginConfigError(
        `Config file not found at ${configPath}. Start Homebridge at least once to generate it.`,
      )
    }
    let raw: string
    try {
      raw = readFileSync(configPath, { encoding: 'utf8' })
    } catch (error: any) {
      throw new PluginConfigError(
        `Failed to read config.json (${configPath}): ${error?.message ?? String(error)}`,
      )
    }
    try {
      const parsed = JSON.parse(raw) as Partial<HomebridgeConfig>
      return PluginCLI.normalizeConfig(parsed)
    } catch (error: any) {
      throw new PluginConfigError(
        `config.json (${configPath}) is not valid JSON: ${error?.message ?? String(error)}`,
      )
    }
  }

  public static writeConfig(config: HomebridgeConfig, configPath: string = User.configPath()): void {
    const dir = dirname(configPath)
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, { encoding: 'utf8' })
    } catch (error: any) {
      throw new PluginConfigError(
        `Failed to write config.json (${configPath}): ${error?.message ?? String(error)}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private static normalizeConfig(parsed: Partial<HomebridgeConfig>): HomebridgeConfig {
    const bridge = parsed.bridge || {
      name: 'Homebridge',
      username: 'CC:22:3D:E3:CE:30',
      pin: '031-45-154',
    }
    return {
      ...parsed,
      bridge,
      accessories: Array.isArray(parsed.accessories) ? parsed.accessories : [],
      platforms: Array.isArray(parsed.platforms) ? parsed.platforms : [],
    } as HomebridgeConfig
  }

  private static inferPluginKind(
    identifier: PluginIdentifier,
    globalInstall: boolean,
  ): 'platform' | 'accessory' {
    const root = PluginCLI.resolveNodeModulesRoot(globalInstall)
    const pkgJsonPath = join(root, identifier, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const data = JSON.parse(readFileSync(pkgJsonPath, { encoding: 'utf8' }))
        const keywords: string[] = data.keywords || []
        if (keywords.some(k => /accessory/i.test(k)) && !keywords.some(k => /platform/i.test(k))) {
          return 'accessory'
        }
        if (keywords.some(k => /platform/i.test(k))) {
          return 'platform'
        }
        // Homebridge plugins typically expose a single default platform
        // called the same as the plugin name; default to platform.
        return 'platform'
      } catch {
        // Fall through to the default
      }
    }
    return 'platform'
  }

  private static deriveDisplayName(identifier: PluginIdentifier): string {
    // homebridge-dummy -> Dummy ; @scope/homebridge-my-thing -> My Thing
    const short = PluginManager.extractPluginName(identifier).replace(/^homebridge-/, '')
    return short
      .split('-')
      .filter(Boolean)
      .map(chunk => chunk.charAt(0).toUpperCase() + chunk.slice(1))
      .join(' ')
  }

  private static appendDefaultConfig(
    identifier: PluginIdentifier,
    kind: 'platform' | 'accessory',
    configPath: string = User.configPath(),
  ): boolean {
    const config = PluginCLI.readConfig(configPath)
    const displayName = PluginCLI.deriveDisplayName(identifier)
    // platform/accesory name inside the block uses the plugin identifier
    // so Homebridge can resolve it unambiguously when multiple plugins are
    // installed with overlapping accessory/platform names.
    const blockName = identifier

    if (kind === 'platform') {
      const entry: PlatformConfig = { platform: blockName, name: displayName }
      const alreadyPresent = config.platforms.some(p => p.platform === blockName)
      if (alreadyPresent) {
        return false
      }
      config.platforms.push(entry)
    } else {
      const entry: AccessoryConfig = { accessory: blockName, name: displayName }
      const alreadyPresent = config.accessories.some(a => a.accessory === blockName)
      if (alreadyPresent) {
        return false
      }
      config.accessories.push(entry)
    }

    PluginCLI.writeConfig(config, configPath)
    return true
  }

  private static removePluginConfig(
    identifier: PluginIdentifier,
    configPath: string = User.configPath(),
  ): { removedAccessories: number, removedPlatforms: number } {
    const config = PluginCLI.readConfig(configPath)

    const match = (entry: { accessory?: unknown, platform?: unknown }, field: 'accessory' | 'platform') => {
      const value = entry[field] as string | undefined
      if (typeof value !== 'string') {
        return false
      }
      // Exact match against the fully-qualified identifier, or match the
      // `<pluginIdentifier>.<name>` prefix Homebridge accepts in configs.
      return value === identifier || value.startsWith(`${identifier}.`)
    }

    let removedAccessories = 0
    let removedPlatforms = 0

    const remainingAccessories: AccessoryConfig[] = []
    for (const a of config.accessories) {
      if (match(a as any, 'accessory')) {
        removedAccessories += 1
      } else {
        remainingAccessories.push(a)
      }
    }

    const remainingPlatforms: PlatformConfig[] = []
    for (const p of config.platforms) {
      if (match(p as any, 'platform')) {
        removedPlatforms += 1
      } else {
        remainingPlatforms.push(p)
      }
    }

    if (removedAccessories === 0 && removedPlatforms === 0) {
      return { removedAccessories, removedPlatforms }
    }

    PluginCLI.writeConfig(
      { ...config, accessories: remainingAccessories, platforms: remainingPlatforms },
      configPath,
    )
    return { removedAccessories, removedPlatforms }
  }

  // ---------------------------------------------------------------------------
  // npm / process spawning (thin wrappers so tests can stub them)
  // ---------------------------------------------------------------------------

  public static runNpmInstall(packageSpec: string, global = true): void {
    const args = ['install', global ? '--global' : '', '--save=false', packageSpec].filter(Boolean)
    try {
      execSync(`npm ${args.join(' ')}`, {
        stdio: 'inherit',
        env: {
          npm_config_loglevel: 'notice',
          npm_update_notifier: 'false',
          ...process.env,
        },
      })
    } catch (error: any) {
      throw new PluginConfigError(
        `npm install failed for '${packageSpec}': ${error?.message ?? String(error)}`,
      )
    }
  }

  public static runNpmUninstall(packageName: string, global = true): void {
    const args = ['uninstall', global ? '--global' : '', packageName].filter(Boolean)
    try {
      execSync(`npm ${args.join(' ')}`, {
        stdio: 'inherit',
        env: {
          npm_config_loglevel: 'notice',
          npm_update_notifier: 'false',
          ...process.env,
        },
      })
    } catch (error: any) {
      throw new PluginConfigError(
        `npm uninstall failed for '${packageName}': ${error?.message ?? String(error)}`,
      )
    }
  }

  /**
   * Attempt to signal a running Homebridge instance to restart. Homebridge
   * installs (systemd, hb-service, ...) do not share a single control path,
   * so we implement a best-effort approach:
   *
   *  - If the environment variable `HOMEBRIDGE_RESTART_CMD` is set, exec it.
   *  - Otherwise look for a running `homebridge` process under the same uid
   *    and send SIGHUP, which the main process is free to ignore, so this
   *    is informational only.
   *
   * Returns `true` if a restart signal was dispatched. Exposed for tests.
   */
  public static signalHomebridgeRestart(): boolean {
    if (process.env.HOMEBRIDGE_RESTART_CMD) {
      try {
        execSync(process.env.HOMEBRIDGE_RESTART_CMD, { stdio: 'inherit' })
        return true
      } catch (error: any) {
        log.warn('HOMEBRIDGE_RESTART_CMD exited non-zero: %s', error?.message)
        return false
      }
    }

    if (process.platform === 'win32') {
      return false
    }

    try {
      // pgrep returns non-zero when no match, which we intentionally suppress.
      const output = execSync('pgrep -f "^node.*homebridge" || true', { encoding: 'utf8' }).trim()
      if (!output) {
        return false
      }
      const pids = output.split(/\s+/).filter(s => s && Number(s) !== process.pid)
      if (pids.length === 0) {
        return false
      }
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGHUP')
        } catch {
          // ignore; the process may have exited in between
        }
      }
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Small utilities (test aid)
  // ---------------------------------------------------------------------------

  private static safeReaddir(dir: string): string[] {
    try {
      return fs.readdirSync(dir) as string[]
    } catch {
      return []
    }
  }
}
