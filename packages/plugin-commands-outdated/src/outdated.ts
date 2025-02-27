import { docsUrl, readProjectManifestOnly, TABLE_OPTIONS } from '@pnpm/cli-utils'
import { FILTERING, OPTIONS, UNIVERSAL_OPTIONS } from '@pnpm/common-cli-options-help'
import { Config, types as allTypes } from '@pnpm/config'
import PnpmError from '@pnpm/error'
import {
  getLockfileImporterId,
  readCurrentLockfile,
  readWantedLockfile,
} from '@pnpm/lockfile-file'
import matcher from '@pnpm/matcher'
import { read as readModulesManifest } from '@pnpm/modules-yaml'
import outdated, { OutdatedPackage } from '@pnpm/outdated'
import semverDiff from '@pnpm/semver-diff'
import storePath from '@pnpm/store-path'
import {
  IncludedDependencies,
  ProjectManifest,
  Registries,
} from '@pnpm/types'
import chalk = require('chalk')
import { oneLine, stripIndent } from 'common-tags'
import path = require('path')
import R = require('ramda')
import renderHelp = require('render-help')
import stripAnsi = require('strip-ansi')
import { table } from 'table'
import wrapAnsi = require('wrap-ansi')
import { createLatestManifestGetter } from './createLatestManifestGetter'
import outdatedRecursive from './recursive'
import {
  DEFAULT_COMPARATORS,
  OutdatedWithVersionDiff,
} from './utils'

export const rcOptionsTypes = cliOptionsTypes

export function cliOptionsTypes () {
  return {
    ...R.pick([
      'depth',
      'dev',
      'global-dir',
      'global',
      'long',
      'optional',
      'production',
      'recursive',
    ], allTypes),
    'compatible': Boolean,
    'table': Boolean,
  }
}

export const commandNames = ['outdated']

export function help () {
  return renderHelp({
    description: stripIndent`
      Check for outdated packages. The check can be limited to a subset of the installed packages by providing arguments (patterns are supported).

      Examples:
      pnpm outdated
      pnpm outdated --long
      pnpm outdated gulp-* @babel/core`,
    descriptionLists: [
      {
        title: 'Options',

        list: [
          {
            description: 'Print only versions that satisfy specs in package.json',
            name: '--compatible',
          },
          {
            description: oneLine`
            By default, details about the outdated packages (such as a link to the repo) are not displayed.
            To display the details, pass this option.`,
            name: '--long',
          },
          {
            description: oneLine`
              Check for outdated dependencies in every package found in subdirectories
              or in every workspace package, when executed inside a workspace.
              For options that may be used with \`-r\`, see "pnpm help recursive"`,
            name: '--recursive',
            shortAlias: '-r',
          },
          {
            description: 'Prints the outdated packages in a list. Good for small consoles',
            name: '--no-table',
          },
          {
            description: 'Check only "dependencies" and "optionalDependencies"',
            name: '--prod',
          },
          {
            description: 'Check only "devDependencies"',
            name: '--dev',
          },
          {
            description: `Don't check "optionalDependencies"`,
            name: '--no-optional',
          },
          OPTIONS.globalDir,
          ...UNIVERSAL_OPTIONS,
        ],
      },
      FILTERING,
    ],
    url: docsUrl('outdated'),
    usages: ['pnpm outdated [<pkg> ...]'],
  })
}

export type OutdatedOptions = {
  alwaysAuth: boolean
  ca?: string
  cert?: string
  compatible?: boolean,
  engineStrict?: boolean
  fetchRetries: number
  fetchRetryFactor: number
  fetchRetryMaxtimeout: number
  fetchRetryMintimeout: number
  global: boolean
  httpsProxy?: string
  independentLeaves: boolean
  key?: string
  localAddress?: string
  long?: boolean
  networkConcurrency: number
  offline: boolean
  dir: string
  proxy?: string
  rawConfig: object
  recursive?: boolean,
  registries: Registries
  lockfileDir?: string
  store?: string
  strictSsl: boolean
  table?: boolean
  tag: string
  userAgent: string,
} & Pick<Config, 'allProjects' |
  'dev' |
  'optional' |
  'production' |
  'selectedProjectsGraph'>

export async function handler (
  args: string[],
  opts: OutdatedOptions,
) {
  const include = {
    dependencies: opts.production !== false,
    devDependencies: opts.dev !== false,
    optionalDependencies: opts.optional !== false,
  }
  if (opts.recursive && opts.selectedProjectsGraph) {
    const pkgs = Object.values(opts.selectedProjectsGraph).map((wsPkg) => wsPkg.package)
    return outdatedRecursive(pkgs, args, { ...opts, include })
  }
  const packages = [
    {
      dir: opts.dir,
      manifest: await readProjectManifestOnly(opts.dir, opts),
    },
  ]
  const { outdatedPackages } = (await outdatedDepsOfProjects(packages, args, { ...opts, include }))[0]

  if (!outdatedPackages.length) return ''

  if (opts.table !== false) {
    return renderOutdatedTable(outdatedPackages, opts)
  } else {
    return renderOutdatedList(outdatedPackages, opts)
  }
}

function renderOutdatedTable (outdatedPackages: ReadonlyArray<OutdatedPackage>, opts: { long?: boolean }) {
  let columnNames = [
    'Package',
    'Current',
    'Latest',
  ]

  let columnFns = [
    renderPackageName,
    renderCurrent,
    renderLatest,
  ]

  if (opts.long) {
    columnNames.push('Details')
    columnFns.push(renderDetails)
  }

  // Avoid the overhead of allocating a new array caused by calling `array.map()`
  for (let i = 0; i < columnNames.length; i++)
    columnNames[i] = chalk.blueBright(columnNames[i])

  return table([
    columnNames,
    ...sortOutdatedPackages(outdatedPackages)
      .map((outdatedPkg) => columnFns.map((fn) => fn(outdatedPkg))),
  ], TABLE_OPTIONS)
}

function renderOutdatedList (outdatedPackages: ReadonlyArray<OutdatedPackage>, opts: { long?: boolean }) {
  return sortOutdatedPackages(outdatedPackages)
    .map((outdatedPkg) => {
      let info = stripIndent`
        ${chalk.bold(renderPackageName(outdatedPkg))}
        ${renderCurrent(outdatedPkg)} ${chalk.grey('=>')} ${renderLatest(outdatedPkg)}`

      if (opts.long) {
        const details = renderDetails(outdatedPkg)

        if (details) {
          info += `\n${details}`
        }
      }

      return info
    })
    .join('\n\n') + '\n'
}

function sortOutdatedPackages (outdatedPackages: ReadonlyArray<OutdatedPackage>) {
  return R.sortWith(
    DEFAULT_COMPARATORS,
    outdatedPackages.map(toOutdatedWithVersionDiff),
  )
}

export function getCellWidth (data: string[][], columnNumber: number, maxWidth: number) {
  const maxCellWidth = data.reduce((cellWidth, row) => {
    const cellLines = stripAnsi(row[columnNumber]).split('\n')
    const currentCellWidth = cellLines.reduce((lineWidth, line) => {
      return Math.max(lineWidth, line.length)
    }, 0)
    return Math.max(cellWidth, currentCellWidth)
  }, 0)
  return Math.min(maxWidth, maxCellWidth)
}

export function toOutdatedWithVersionDiff<T> (outdated: T & OutdatedPackage): T & OutdatedWithVersionDiff {
  if (outdated.latestManifest) {
    return {
      ...outdated,
      ...semverDiff(outdated.wanted, outdated.latestManifest.version),
    }
  }
  return {
    ...outdated,
    change: 'unknown',
  }
}

export function renderPackageName ({ belongsTo, packageName }: OutdatedPackage) {
  switch (belongsTo) {
    case 'devDependencies': return `${packageName} ${chalk.dim('(dev)')}`
    case 'optionalDependencies': return `${packageName} ${chalk.dim('(optional)')}`
    default: return packageName
  }
}

export function renderCurrent ({ current, wanted }: OutdatedPackage) {
  let output = current || 'missing'
  if (current === wanted) return output
  return `${output} (wanted ${wanted})`
}

const DIFF_COLORS = {
  feature: chalk.yellowBright.bold,
  fix: chalk.greenBright.bold,
}

export function renderLatest (outdatedPkg: OutdatedWithVersionDiff): string {
  const { latestManifest, change, diff } = outdatedPkg
  if (!latestManifest) return ''
  if (change === null || !diff) {
    return latestManifest.deprecated
      ? chalk.redBright.bold('Deprecated')
      : latestManifest.version
  }

  const highlight = DIFF_COLORS[change] || chalk.redBright.bold
  const same = joinVersionTuples(diff[0], 0)
  const other = highlight(joinVersionTuples(diff[1], diff[0].length))
  if (!same) return other
  if (!other) {
    // Happens when current is 1.0.0-rc.0 and latest is 1.0.0
    return same
  }
  return diff[0].length === 3 ? `${same}-${other}` : `${same}.${other}`
}

function joinVersionTuples (versionTuples: string[], startIndex: number) {
  const neededForSemver = 3 - startIndex
  if (versionTuples.length <= neededForSemver || neededForSemver === 0) {
    return versionTuples.join('.')
  }
  return `${
    versionTuples.slice(0, neededForSemver).join('.')
   }-${
     versionTuples.slice(neededForSemver).join('.')
   }`
}

export function renderDetails ({ latestManifest }: OutdatedPackage) {
  if (!latestManifest) return ''
  const outputs = []
  if (latestManifest.deprecated) {
    outputs.push(wrapAnsi(chalk.redBright(latestManifest.deprecated), 40))
  }
  if (latestManifest.homepage) {
    outputs.push(chalk.underline(latestManifest.homepage))
  }
  return outputs.join('\n')
}

export async function outdatedDepsOfProjects (
  pkgs: Array<{dir: string, manifest: ProjectManifest}>,
  args: string[],
  opts: OutdatedOptions & { include: IncludedDependencies },
) {
  const lockfileDir = opts.lockfileDir || opts.dir
  const modules = await readModulesManifest(path.join(lockfileDir, 'node_modules'))
  const virtualStoreDir = modules?.virtualStoreDir || path.join(lockfileDir, 'node_modules/.pnpm')
  const currentLockfile = await readCurrentLockfile(virtualStoreDir, { ignoreIncompatible: false })
  const wantedLockfile = await readWantedLockfile(lockfileDir, { ignoreIncompatible: false }) || currentLockfile
  if (!wantedLockfile) {
    throw new PnpmError('OUTDATED_NO_LOCKFILE', 'No lockfile in this directory. Run `pnpm install` to generate one.')
  }
  const storeDir = await storePath(opts.dir, opts.store)
  const getLatestManifest = createLatestManifestGetter({
    ...opts,
    lockfileDir,
    storeDir,
  })
  return Promise.all(pkgs.map(async ({ dir, manifest }) => {
    let match = args.length && matcher(args) || undefined
    return {
      manifest,
      outdatedPackages: await outdated({
        compatible: opts.compatible,
        currentLockfile,
        getLatestManifest,
        include: opts.include,
        lockfileDir,
        manifest,
        match,
        prefix: dir,
        wantedLockfile,
      }),
      prefix: getLockfileImporterId(lockfileDir, dir),
    }
  }))
}
