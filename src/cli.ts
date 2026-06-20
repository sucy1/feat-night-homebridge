/* global NodeJS */

import type { HomebridgeOptions } from './server.js'

import process from 'node:process'

import { HAPStorage } from '@homebridge/hap-nodejs'
import { Command } from 'commander'
import { satisfies } from 'semver'

import { Logger } from './logger.js'
import { PluginCLI, PluginConfigError } from './pluginCLI.js'
import { Server } from './server.js'
import { User } from './user.js'
import getVersion, { getRequiredNodeVersion } from './version.js'

import 'source-map-support/register.js'

import Signals = NodeJS.Signals

const log = Logger.internal

const requiredNodeVersion = getRequiredNodeVersion()
if (requiredNodeVersion && !satisfies(process.version, requiredNodeVersion)) {
  log.warn(`Homebridge requires a Node.js version of ${requiredNodeVersion} which does \
not satisfy the current Node.js version of ${process.version}. You may need to upgrade your installation of Node.js - see https://homebridge.io/w/JTKEF`)
}

export default function cli(): void {
  let insecureAccess = false
  let hideQRCode = false
  let keepOrphans = false
  let customPluginPath: string | undefined
  let strictPluginResolution = false
  let noLogTimestamps = false
  let debugModeEnabled = false
  let forceColourLogging = false
  let customStoragePath: string | undefined

  let shuttingDown = false

  const program = new Command()
  program
    .name('homebridge')
    .description('HomeKit support for the impatient')
    .version(getVersion())
    .allowExcessArguments()
    .option('-C, --color', 'force color in logging', () => forceColourLogging = true)
    .option('-D, --debug', 'turn on debug level logging', () => debugModeEnabled = true)
    .option('-I, --insecure', 'allow unauthenticated requests (for easier hacking)', () => insecureAccess = true)
    .option('-P, --plugin-path [path]', 'look for plugins installed at [path] as well as the default locations ([path] can also point to a single plugin)', path => customPluginPath = path)
    .option('-Q, --no-qrcode', 'do not issue QRcode in logging', () => hideQRCode = true)
    .option('-K, --keep-orphans', 'keep cached accessories for which the associated plugin is not loaded', () => keepOrphans = true)
    .option('-T, --no-timestamp', 'do not issue timestamps in logging', () => noLogTimestamps = true)
    .option('-U, --user-storage-path [path]', 'look for homebridge user files at [path] instead of the default location (~/.homebridge)', path => customStoragePath = path)
    .option('--strict-plugin-resolution', 'only load plugins from the --plugin-path if set, otherwise from the primary global node_modules', () => strictPluginResolution = true)

  const plugin = program.command('plugin').description('Manage Homebridge plugins')

  plugin
    .command('install <plugin>')
    .alias('add')
    .description('Install a Homebridge plugin and add a default entry to config.json')
    .option('--no-global', 'install locally in the current working directory instead of globally')
    .option('-V, --version <version>', 'install a specific version or npm tag (e.g. "latest", "1.2.3")')
    .option('--kind <kind>', 'force the kind of default config entry: "platform" or "accessory"', /^(platform|accessory)$/i)
    .option('--no-restart', 'do not attempt to signal the running Homebridge to restart')
    .action(async (pluginName: string, opts: any) => {
      applyGlobalLoggingOptions({ noLogTimestamps, debugModeEnabled, forceColourLogging, customStoragePath })
      try {
        await PluginCLI.install(pluginName, {
          global: opts.global,
          version: opts.version,
          kind: opts.kind?.toLowerCase() as 'platform' | 'accessory' | undefined,
          noRestart: !opts.restart,
        })
      } catch (error: any) {
        handlePluginError(error)
      }
    })

  plugin
    .command('uninstall <plugin>')
    .alias('remove')
    .description('Uninstall a Homebridge plugin and remove its entries from config.json')
    .option('--no-global', 'uninstall locally in the current working directory instead of globally')
    .option('--keep-config', 'keep the plugin\'s entries in config.json')
    .option('--no-restart', 'do not attempt to signal the running Homebridge to restart')
    .action(async (pluginName: string, opts: any) => {
      applyGlobalLoggingOptions({ noLogTimestamps, debugModeEnabled, forceColourLogging, customStoragePath })
      try {
        await PluginCLI.uninstall(pluginName, {
          global: opts.global,
          keepConfig: opts.keepConfig,
          noRestart: !opts.restart,
        })
      } catch (error: any) {
        handlePluginError(error)
      }
    })

  plugin
    .command('list')
    .alias('ls')
    .description('List installed Homebridge plugins')
    .option('--no-global', 'scan the local node_modules directory instead of the global one')
    .action((opts: any) => {
      applyGlobalLoggingOptions({ noLogTimestamps, debugModeEnabled, forceColourLogging, customStoragePath })
      const plugins = PluginCLI.list({ global: opts.global })
      if (plugins.length === 0) {
        log.info('No Homebridge plugins found.')
        return
      }
      const width = Math.max(...plugins.map(p => p.identifier.length), 20)
      for (const p of plugins) {
        console.log(`${p.identifier.padEnd(width, ' ')}  ${p.version.padEnd(10, ' ')}  ${p.scope ?? ''}`)
      }
    })

  program
    .action(() => {
      runServer()
    })

  program.parseAsync(process.argv).catch((error: Error) => {
    log.error(error.stack || error.message)
    process.exit(1)
  })

  function applyGlobalLoggingOptions(opts: {
    noLogTimestamps: boolean
    debugModeEnabled: boolean
    forceColourLogging: boolean
    customStoragePath?: string
  }): void {
    if (opts.noLogTimestamps) {
      Logger.setTimestampEnabled(false)
    }
    if (opts.debugModeEnabled) {
      Logger.setDebugEnabled(true)
    }
    if (opts.forceColourLogging) {
      Logger.forceColor()
    }
    if (opts.customStoragePath) {
      User.setStoragePath(opts.customStoragePath)
    }
  }

  function handlePluginError(error: unknown): void {
    if (error instanceof PluginConfigError) {
      log.error(error.message)
    } else if (error instanceof Error) {
      log.error(error.stack || error.message)
    } else {
      log.error(String(error))
    }
    process.exit(1)
  }

  function runServer(): void {
    applyGlobalLoggingOptions({ noLogTimestamps, debugModeEnabled, forceColourLogging, customStoragePath })

    // Initialize HAP-NodeJS with a custom persist directory
    HAPStorage.setCustomStoragePath(User.persistPath())

    const options: HomebridgeOptions = {
      keepOrphanedCachedAccessories: keepOrphans,
      insecureAccess,
      hideQRCode,
      customPluginPath,
      noLogTimestamps,
      debugModeEnabled,
      forceColourLogging,
      customStoragePath,
      strictPluginResolution,
    }

    const server = new Server(options)

    const signalHandler = (signal: Signals, signalNum: number): void => {
      if (shuttingDown) {
        return
      }
      shuttingDown = true

      log.info('Got %s, shutting down Homebridge...', signal)
      setTimeout(() => process.exit(128 + signalNum), 5000)

      void server.teardown()
    }
    process.on('SIGINT', signalHandler.bind(undefined, 'SIGINT', 2))
    process.on('SIGTERM', signalHandler.bind(undefined, 'SIGTERM', 15))

    const errorHandler = (error: Error): void => {
      if (error.stack) {
        log.error(error.stack)
      }

      if (!shuttingDown) {
        process.kill(process.pid, 'SIGTERM')
      }
    }
    process.on('uncaughtException', errorHandler)
    server.start().catch(errorHandler)
  }
}
