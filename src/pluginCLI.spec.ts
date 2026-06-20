import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomebridgeConfig } from './bridgeService.js'
import { InstalledPluginInfo, PluginCLI, PluginConfigError } from './pluginCLI.js'
import { User } from './user.js'

const sampleConfig: HomebridgeConfig = {
  bridge: {
    name: 'Homebridge',
    username: 'CC:22:3D:E3:CE:30',
    manufacturer: 'homebridge.io',
    model: 'homebridge',
    port: 51826,
    pin: '031-45-154',
  },
  accessories: [
    { accessory: 'homebridge-existing.OldSwitch', name: 'Old Switch' },
  ],
  platforms: [
    { platform: 'homebridge-existing', name: 'Existing' },
  ],
} as HomebridgeConfig

describe('pluginCLI', () => {
  let tmpHome: string
  let configPath: string
  let fakeNodeModules: string

  function writeConfig(partial?: Partial<HomebridgeConfig> | string): void {
    const data = typeof partial === 'string' ? partial : JSON.stringify({ ...sampleConfig, ...partial }, null, 4)
    writeFileSync(configPath, data)
  }

  function readConfig(): HomebridgeConfig {
    return PluginCLI.readConfig(configPath)
  }

  function seedFakePlugin(name: string, version = '1.0.0', extra: Record<string, unknown> = {}): void {
    const isScoped = name.startsWith('@')
    const dir = isScoped ? join(fakeNodeModules, name) : join(fakeNodeModules, name)
    fs.mkdirpSync(dir)
    const keywords: string[] = ['homebridge-plugin']
    if (extra.keywords) {
      keywords.push(...(extra.keywords as string[]))
    }
    const pkg: Record<string, unknown> = {
      name,
      version,
      keywords,
      main: 'index.js',
      engines: { homebridge: '>=1.0.0', node: '>=18' },
      ...extra,
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    writeFileSync(join(dir, 'index.js'), 'export default () => {}')
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'homebridge-plugin-cli-'))
    configPath = join(tmpHome, 'config.json')
    fakeNodeModules = join(tmpHome, 'node_modules')
    fs.mkdirpSync(join(tmpHome, '.homebridge'))

    // Make User.configPath point inside our temp folder. `User.setStoragePath`
    // throws if storage has already been accessed (it has in other tests), so
    // we bypass it by monkey-patching `configPath`.
    vi.spyOn(User, 'configPath').mockReturnValue(configPath)

    writeConfig()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  // =========================================================================
  // readConfig / writeConfig: happy path + every meaningful failure
  // =========================================================================
  describe('readConfig & writeConfig', () => {
    it('reads a valid config.json and normalises missing arrays', () => {
      writeFileSync(configPath, JSON.stringify({
        bridge: sampleConfig.bridge,
        accessories: undefined,
      }))
      const cfg = PluginCLI.readConfig(configPath)
      expect(cfg.accessories).toEqual([])
      expect(cfg.platforms).toEqual([])
      expect(cfg.bridge).toEqual(sampleConfig.bridge)
    })

    it('throws PluginConfigError when config file is missing', () => {
      fs.unlinkSync(configPath)
      expect(() => PluginCLI.readConfig(configPath)).toThrow(PluginConfigError)
      expect(() => PluginCLI.readConfig(configPath)).toThrow(/Config file not found/)
    })

    it('throws PluginConfigError with readable message on JSON syntax errors', () => {
      writeConfig('{ "bridge": { ')
      expect(() => PluginCLI.readConfig(configPath)).toThrow(PluginConfigError)
      expect(() => PluginCLI.readConfig(configPath)).toThrow(/not valid JSON/)
    })

    it('throws PluginConfigError when the config file is not readable', () => {
      // Point configPath at a directory; readFileSync will throw EISDIR,
      // which the readConfig wrapper translates into a PluginConfigError.
      expect(() => PluginCLI.readConfig(tmpHome)).toThrow(PluginConfigError)
      expect(() => PluginCLI.readConfig(tmpHome)).toThrow(/Failed to read config.json/)
    })

    it('writes pretty JSON and creates the parent directory if missing', () => {
      const nested = join(tmpHome, 'deeper', 'config.json')
      PluginCLI.writeConfig(sampleConfig, nested)
      const raw = fs.readFileSync(nested, { encoding: 'utf8' })
      expect(raw.startsWith('{\n')).toBe(true)
      expect(raw.endsWith('\n')).toBe(true)
      expect(JSON.parse(raw) as HomebridgeConfig).toEqual(sampleConfig)
    })

    it('throws PluginConfigError when writing to a non-writable path', () => {
      // Put a regular file in the way so mkdirSync({ recursive: true }) fails
      // with ENOTDIR — this triggers the write error branch without relying
      // on POSIX permission bits (which are ignored when running as root).
      const blocker = join(tmpHome, 'blocker')
      writeFileSync(blocker, '')
      const badPath = join(blocker, 'config.json')
      expect(() => PluginCLI.writeConfig(sampleConfig, badPath)).toThrow(PluginConfigError)
      expect(() => PluginCLI.writeConfig(sampleConfig, badPath)).toThrow(/Failed to write config.json/)
    })
  })

  // =========================================================================
  // install: npm + config append
  // =========================================================================
  describe('install', () => {
    it('rejects malformed plugin names early with PluginConfigError', async () => {
      await expect(PluginCLI.install('not-a-valid-name', { noRestart: true })).rejects.toThrow(PluginConfigError)
    })

    it('runs npm install, appends a default platform config, and skips duplicate entries', async () => {
      const npmSpy = vi.spyOn(PluginCLI, 'runNpmInstall').mockImplementation(() => {
        // Seed the fake plugin after npm "installs" it.
        seedFakePlugin('homebridge-dummy', '2.0.0')
      })
      const restartSpy = vi.spyOn(PluginCLI, 'signalHomebridgeRestart').mockReturnValue(true)

      await PluginCLI.install('homebridge-dummy', { noRestart: false, global: false })

      expect(npmSpy).toHaveBeenCalledWith('homebridge-dummy', false)
      expect(restartSpy).toHaveBeenCalled()

      // First append happened.
      let cfg = readConfig()
      expect(cfg.platforms).toContainEqual(
        expect.objectContaining({ platform: 'homebridge-dummy', name: 'Dummy' }),
      )
      expect(cfg.accessories).toEqual(sampleConfig.accessories) // untouched

      // Second call should be idempotent: no new entry, no crash.
      await PluginCLI.install('homebridge-dummy', { noRestart: true, global: false })
      cfg = readConfig()
      const matches = cfg.platforms.filter(p => p.platform === 'homebridge-dummy')
      expect(matches).toHaveLength(1)

      npmSpy.mockRestore()
      restartSpy.mockRestore()
    })

    it('honours --kind accessory and scoped identifiers', async () => {
      const npmSpy = vi.spyOn(PluginCLI, 'runNpmInstall').mockImplementation(() => {
        seedFakePlugin('@acme/homebridge-dimmer', '0.3.1', { keywords: ['homebridge-accessory'] })
      })

      await PluginCLI.install('@acme/homebridge-dimmer', {
        kind: 'accessory',
        noRestart: true,
        global: false,
        version: '0.3.1',
      })

      expect(npmSpy).toHaveBeenCalledWith('@acme/homebridge-dimmer@0.3.1', false)
      const cfg = readConfig()
      expect(cfg.accessories).toContainEqual(
        expect.objectContaining({
          accessory: '@acme/homebridge-dimmer',
          name: 'Dimmer',
        }),
      )
      // Matching platforms must remain untouched.
      expect(cfg.platforms).toEqual(sampleConfig.platforms)

      npmSpy.mockRestore()
    })

    it('surfaces npm failures as PluginConfigError', async () => {
      vi.spyOn(PluginCLI, 'runNpmInstall').mockImplementation(() => {
        throw new PluginConfigError('npm install failed for \'homebridge-404\': npm ERR! 404 Not Found')
      })
      await expect(
        PluginCLI.install('homebridge-404', { noRestart: true, global: false }),
      ).rejects.toThrow(PluginConfigError)
    })
  })

  // =========================================================================
  // uninstall: npm remove + config removal
  // =========================================================================
  describe('uninstall', () => {
    it('rejects malformed plugin names early with PluginConfigError', async () => {
      await expect(PluginCLI.uninstall('garbage-name', { noRestart: true })).rejects.toThrow(PluginConfigError)
    })

    it('uninstalls the package and removes every matching config entry', async () => {
      // Seed a plugin that has BOTH a platform entry and a qualified accessory
      // entry (pluginIdentifier.AccessoryName) to exercise both removal paths.
      writeConfig({
        accessories: [
          { accessory: 'homebridge-existing.OldSwitch', name: 'Old Switch' },
          { accessory: 'homebridge-dummy.Switch', name: 'Dummy Switch' },
          { accessory: 'unrelated', name: 'should stay' },
        ],
        platforms: [
          { platform: 'homebridge-dummy', name: 'Dummy' },
          { platform: 'homebridge-existing', name: 'Existing' },
        ],
      })

      const npmSpy = vi.spyOn(PluginCLI, 'runNpmUninstall').mockImplementation(() => {})
      const restartSpy = vi.spyOn(PluginCLI, 'signalHomebridgeRestart').mockReturnValue(true)

      await PluginCLI.uninstall('homebridge-dummy', { noRestart: false, global: false })

      expect(npmSpy).toHaveBeenCalledWith('homebridge-dummy', false)
      expect(restartSpy).toHaveBeenCalled()

      const cfg = readConfig()
      expect(cfg.platforms.map(p => p.platform)).toEqual(['homebridge-existing'])
      expect(cfg.accessories.map(a => a.accessory)).toEqual([
        'homebridge-existing.OldSwitch',
        'unrelated',
      ])

      npmSpy.mockRestore()
      restartSpy.mockRestore()
    })

    it('supports --keep-config which preserves the config entries', async () => {
      writeConfig({
        platforms: [{ platform: 'homebridge-keep-me', name: 'Keeper' }],
      })

      const npmSpy = vi.spyOn(PluginCLI, 'runNpmUninstall').mockImplementation(() => {})

      await PluginCLI.uninstall('homebridge-keep-me', {
        keepConfig: true,
        noRestart: true,
        global: false,
      })

      expect(npmSpy).toHaveBeenCalled()
      expect(readConfig().platforms).toHaveLength(1)

      npmSpy.mockRestore()
    })

    it('does not fail when no matching entries exist (idempotent)', async () => {
      vi.spyOn(PluginCLI, 'runNpmUninstall').mockImplementation(() => {})
      await expect(
        PluginCLI.uninstall('homebridge-no-such-entry', { noRestart: true, global: false }),
      ).resolves.toBeUndefined()
      const cfg = readConfig()
      expect(cfg.accessories).toHaveLength(1)
      expect(cfg.platforms).toHaveLength(1)
    })

    it('surfaces npm failures as PluginConfigError', async () => {
      vi.spyOn(PluginCLI, 'runNpmUninstall').mockImplementation(() => {
        throw new PluginConfigError('npm uninstall failed for \'homebridge-oops\': npm ERR! ENOENT')
      })
      await expect(
        PluginCLI.uninstall('homebridge-oops', { noRestart: true, global: false }),
      ).rejects.toThrow(PluginConfigError)
    })
  })

  // =========================================================================
  // list: scan fake node_modules
  // =========================================================================
  describe('list', () => {
    it('returns an empty list when the node_modules directory does not exist', () => {
      vi.spyOn(PluginCLI, 'resolveNodeModulesRoot').mockReturnValue(join(tmpHome, 'nope'))
      expect(PluginCLI.list({ global: false })).toEqual([])
    })

    it('enumerates scoped and unscoped plugins, ignoring non-homebridge packages', () => {
      vi.spyOn(PluginCLI, 'resolveNodeModulesRoot').mockReturnValue(fakeNodeModules)

      seedFakePlugin('homebridge-alpha', '1.2.3')
      seedFakePlugin('homebridge-beta', '0.1.0')
      seedFakePlugin('@acme/homebridge-gamma', '4.5.6')
      // Non-homebridge package that happens to sit in the same folder.
      fs.mkdirpSync(join(fakeNodeModules, 'left-pad'))
      writeFileSync(
        join(fakeNodeModules, 'left-pad', 'package.json'),
        JSON.stringify({ name: 'left-pad', version: '0.0.1' }),
      )
      // Homebridge-named package without the `homebridge-plugin` keyword.
      fs.mkdirpSync(join(fakeNodeModules, 'homebridge-unkeyworded'))
      writeFileSync(
        join(fakeNodeModules, 'homebridge-unkeyworded', 'package.json'),
        JSON.stringify({ name: 'homebridge-unkeyworded', version: '0.0.1' }),
      )
      // Unreadable package.json should be silently skipped.
      fs.mkdirpSync(join(fakeNodeModules, 'homebridge-broken-pkg'))

      const listed = PluginCLI.list({ global: false })

      expect(listed.map((p: InstalledPluginInfo) => `${p.identifier}@${p.version}`)).toEqual([
        '@acme/homebridge-gamma@4.5.6',
        'homebridge-alpha@1.2.3',
        'homebridge-beta@0.1.0',
      ])

      const scoped = listed.find((p: InstalledPluginInfo) => p.scope)
      expect(scoped?.scope).toBe('@acme')
      expect(scoped?.name).toBe('homebridge-gamma')
    })
  })

  // =========================================================================
  // signalHomebridgeRestart: via HOMEBRIDGE_RESTART_CMD env var
  // =========================================================================
  describe('signalHomebridgeRestart', () => {
    it('executes HOMEBRIDGE_RESTART_CMD when set and returns true', () => {
      const markerFile = join(tmpHome, 'restarted')
      const cmd = process.platform === 'win32'
        ? `type nul > "${markerFile}"`
        : `touch "${markerFile}"`
      process.env.HOMEBRIDGE_RESTART_CMD = cmd
      try {
        expect(PluginCLI.signalHomebridgeRestart()).toBe(true)
        expect(fs.existsSync(markerFile)).toBe(true)
      } finally {
        delete process.env.HOMEBRIDGE_RESTART_CMD
      }
    })

    it('returns false (without throwing) when HOMEBRIDGE_RESTART_CMD fails', () => {
      process.env.HOMEBRIDGE_RESTART_CMD = process.platform === 'win32'
        ? 'cmd /c exit 42'
        : 'exit 42'
      try {
        expect(PluginCLI.signalHomebridgeRestart()).toBe(false)
      } finally {
        delete process.env.HOMEBRIDGE_RESTART_CMD
      }
    })
  })
})
