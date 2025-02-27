import buildModules, { linkBinsOfDependencies } from '@pnpm/build-modules'
import {
  LAYOUT_VERSION,
  LOCKFILE_VERSION,
  WANTED_LOCKFILE,
} from '@pnpm/constants'
import {
  packageManifestLogger,
  stageLogger,
  summaryLogger,
} from '@pnpm/core-loggers'
import PnpmError from '@pnpm/error'
import getContext, { PnpmContext, ProjectOptions } from '@pnpm/get-context'
import headless from '@pnpm/headless'
import {
  runLifecycleHooksConcurrently,
} from '@pnpm/lifecycle'
import linkBins from '@pnpm/link-bins'
import {
  Lockfile,
  ProjectSnapshot,
  writeCurrentLockfile,
  writeLockfiles,
  writeWantedLockfile,
} from '@pnpm/lockfile-file'
import { satisfiesPackageManifest } from '@pnpm/lockfile-utils'
import logger, {
  streamParser,
} from '@pnpm/logger'
import { write as writeModulesYaml } from '@pnpm/modules-yaml'
import readModulesDirs from '@pnpm/read-modules-dir'
import resolveDependencies, {
  ResolvedPackage,
} from '@pnpm/resolve-dependencies'
import {
  PreferredVersions,
  Resolution,
  WorkspacePackages,
} from '@pnpm/resolver-base'
import {
  DEPENDENCIES_FIELDS,
  DependenciesField,
  DependencyManifest,
  ProjectManifest,
  Registries,
} from '@pnpm/types'
import {
  getAllDependenciesFromPackage,
  safeReadPackageFromDir as safeReadPkgFromDir,
} from '@pnpm/utils'
import rimraf = require('@zkochan/rimraf')
import * as dp from 'dependency-path'
import isInnerLink = require('is-inner-link')
import isSubdir = require('is-subdir')
import pEvery from 'p-every'
import pFilter = require('p-filter')
import pLimit from 'p-limit'
import path = require('path')
import R = require('ramda')
import semver = require('semver')
import getSpecFromPackageManifest from '../getSpecFromPackageManifest'
import lock from '../lock'
import lockfilesEqual from '../lockfilesEqual'
import parseWantedDependencies from '../parseWantedDependencies'
import safeIsInnerLink from '../safeIsInnerLink'
import removeDeps from '../uninstall/removeDeps'
import { updateProjectManifest } from '../utils/getPref'
import extendOptions, {
  InstallOptions,
  StrictInstallOptions,
} from './extendInstallOptions'
import getPreferredVersionsFromPackage, { getPreferredVersionsFromLockfile } from './getPreferredVersions'
import getWantedDependencies, {
  PinnedVersion,
  WantedDependency,
} from './getWantedDependencies'
import linkPackages, {
  DependenciesGraph,
  DependenciesGraphNode,
  Project as ProjectToLink,
} from './link'
import { absolutePathToRef } from './lockfile'

export type DependenciesMutation = (
  {
    buildIndex: number,
    mutation: 'install',
    pruneDirectDependencies?: boolean,
  } | {
    allowNew?: boolean,
    dependencySelectors: string[],
    mutation: 'installSome',
    peer?: boolean,
    pruneDirectDependencies?: boolean,
    pinnedVersion?: PinnedVersion,
    targetDependenciesField?: DependenciesField,
  } | {
    mutation: 'uninstallSome',
    dependencyNames: string[],
    targetDependenciesField?: DependenciesField,
  } | {
    mutation: 'unlink',
  } | {
    mutation: 'unlinkSome',
    dependencyNames: string[],
  }
) & (
  {
    manifest: ProjectManifest,
  }
)

export async function install (
  manifest: ProjectManifest,
  opts: InstallOptions & {
    preferredVersions?: PreferredVersions,
  },
) {
  const projects = await mutateModules(
    [
      {
        buildIndex: 0,
        manifest,
        mutation: 'install',
        rootDir: opts.dir || process.cwd(),
      },
    ],
    opts,
  )
  return projects[0].manifest
}

export type MutatedProject = ProjectOptions & DependenciesMutation

export async function mutateModules (
  projects: MutatedProject[],
  maybeOpts: InstallOptions & {
    preferredVersions?: PreferredVersions,
  },
) {
  const reporter = maybeOpts?.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }

  const opts = await extendOptions(maybeOpts)

  if (!opts.include.dependencies && opts.include.optionalDependencies) {
    throw new PnpmError('OPTIONAL_DEPS_REQUIRE_PROD_DEPS', 'Optional dependencies cannot be installed without production dependencies')
  }

  const ctx = await getContext(projects, opts)

  for (const { manifest, rootDir } of ctx.projects) {
    if (!manifest) {
      throw new Error(`No package.json found in "${rootDir}"`)
    }
  }

  let result!: Array<{ rootDir: string, manifest: ProjectManifest }>
  try {
    if (opts.lock) {
      result = await lock(ctx.lockfileDir, _install, {
        locks: opts.locks,
        prefix: ctx.lockfileDir,
        stale: opts.lockStaleDuration,
        storeController: opts.storeController,
      })
    } else {
      result = await _install()
    }
  } finally {
    await opts.storeController.saveState()
  }

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }

  return result

  async function _install (): Promise<Array<{ rootDir: string, manifest: ProjectManifest }>> {
    const installsOnly = projects.every((project) => project.mutation === 'install')
    if (
      !opts.lockfileOnly &&
      !opts.update &&
      installsOnly &&
      (
        opts.frozenLockfile ||
        opts.preferFrozenLockfile &&
        (!opts.pruneLockfileImporters || Object.keys(ctx.wantedLockfile.importers).length === ctx.projects.length) &&
        ctx.existsWantedLockfile &&
        ctx.wantedLockfile.lockfileVersion === LOCKFILE_VERSION &&
        await pEvery(ctx.projects, async (project) =>
          !hasLocalTarballDepsInRoot(ctx.wantedLockfile, project.id) &&
          satisfiesPackageManifest(ctx.wantedLockfile, project.manifest, project.id) &&
          linkedPackagesAreUpToDate(project.manifest, ctx.wantedLockfile.importers[project.id], project.rootDir, opts.workspacePackages),
        )
      )
    ) {
      if (!ctx.existsWantedLockfile) {
        if (ctx.projects.some((project) => pkgHasDependencies(project.manifest))) {
          throw new Error(`Headless installation requires a ${WANTED_LOCKFILE} file`)
        }
      } else {
        logger.info({ message: 'Lockfile is up-to-date, resolution step is skipped', prefix: opts.lockfileDir })
        await headless({
          currentEngine: {
            nodeVersion: opts.nodeVersion,
            pnpmVersion: opts.packageManager.name === 'pnpm' ? opts.packageManager.version : '',
          },
          currentLockfile: ctx.currentLockfile,
          engineStrict: opts.engineStrict,
          extraBinPaths: opts.extraBinPaths,
          force: opts.force,
          hoistedAliases: ctx.hoistedAliases,
          hoistPattern: ctx.hoistPattern,
          ignoreScripts: opts.ignoreScripts,
          include: opts.include,
          independentLeaves: opts.independentLeaves,
          lockfileDir: ctx.lockfileDir,
          ownLifecycleHooksStdio: opts.ownLifecycleHooksStdio,
          packageManager:  opts.packageManager,
          pendingBuilds: ctx.pendingBuilds,
          projects: ctx.projects as Array<{
            binsDir: string,
            buildIndex: number,
            id: string,
            manifest: ProjectManifest,
            modulesDir: string,
            rootDir: string,
            pruneDirectDependencies?: boolean,
          }>,
          pruneStore: opts.pruneStore,
          rawConfig: opts.rawConfig,
          registries: opts.registries,
          shamefullyHoist: ctx.shamefullyHoist,
          sideEffectsCacheRead: opts.sideEffectsCacheRead,
          sideEffectsCacheWrite: opts.sideEffectsCacheWrite,
          skipped: ctx.skipped,
          storeController: opts.storeController,
          storeDir: opts.storeDir,
          unsafePerm: opts.unsafePerm,
          userAgent: opts.userAgent,
          virtualStoreDir: ctx.virtualStoreDir,
          wantedLockfile: ctx.wantedLockfile,
        })
        return projects
      }
    }

    const projectsToInstall = [] as ImporterToUpdate[]

    const projectsToBeInstalled = ctx.projects.filter(({ mutation }) => mutation === 'install') as Array<{ buildIndex: number, rootDir: string, manifest: ProjectManifest, modulesDir: string }>
    const scriptsOpts = {
      extraBinPaths: opts.extraBinPaths,
      rawConfig: opts.rawConfig,
      stdio: opts.ownLifecycleHooksStdio,
      unsafePerm: opts.unsafePerm || false,
    }
    if (!opts.ignoreScripts) {
      await runLifecycleHooksConcurrently(
        ['preinstall'],
        projectsToBeInstalled,
        opts.childConcurrency,
        scriptsOpts,
      )
    }

    // TODO: make it concurrent
    for (const project of ctx.projects) {
      switch (project.mutation) {
        case 'uninstallSome':
          projectsToInstall.push({
            pruneDirectDependencies: false,
            ...project,
            removePackages: project.dependencyNames,
            updatePackageManifest: true,
            wantedDependencies: [],
          })
          break
        case 'install': {
          await installCase(project)
          break
        }
        case 'installSome': {
          await installSome({
            ...project,
            updatePackageManifest: true,
          })
          break
        }
        case 'unlink': {
          const packageDirs = await readModulesDirs(project.modulesDir)
          const externalPackages = await pFilter(
            packageDirs!,
            (packageDir: string) => isExternalLink(ctx.storeDir, project.modulesDir, packageDir),
          )
          const allDeps = getAllDependenciesFromPackage(project.manifest)
          const packagesToInstall: string[] = []
          for (const pkgName of externalPackages) {
            await rimraf(path.join(project.modulesDir, pkgName))
            if (allDeps[pkgName]) {
              packagesToInstall.push(pkgName)
            }
          }
          if (!packagesToInstall.length) return projects

          // TODO: install only those that were unlinked
          // but don't update their version specs in package.json
          await installCase({ ...project, mutation: 'install' })
          break
        }
        case 'unlinkSome': {
          const packagesToInstall: string[] = []
          const allDeps = getAllDependenciesFromPackage(project.manifest)
          for (const depName of project.dependencyNames) {
            try {
              if (!await isExternalLink(ctx.storeDir, project.modulesDir, depName)) {
                logger.warn({
                  message: `${depName} is not an external link`,
                  prefix: project.rootDir,
                })
                continue
              }
            } catch (err) {
              if (err['code'] !== 'ENOENT') throw err // tslint:disable-line:no-string-literal
            }
            await rimraf(path.join(project.modulesDir, depName))
            if (allDeps[depName]) {
              packagesToInstall.push(depName)
            }
          }
          if (!packagesToInstall.length) return projects

          // TODO: install only those that were unlinked
          // but don't update their version specs in package.json
          await installSome({
            ...project,
            dependencySelectors: packagesToInstall,
            mutation: 'installSome',
            updatePackageManifest: false,
          })
          break
        }
      }
    }

    async function installCase (project: any) { // tslint:disable-line:no-any
      const wantedDependencies = getWantedDependencies(project.manifest, { updateWorkspaceDependencies: opts.update })
        .map((wantedDependency) => ({ ...wantedDependency, updateSpec: true }))

      if (ctx.wantedLockfile?.importers) {
        forgetResolutionsOfPrevWantedDeps(ctx.wantedLockfile.importers[project.id], wantedDependencies)
      }
      const scripts = opts.ignoreScripts ? {} : (project.manifest?.scripts ?? {})
      if (opts.ignoreScripts && project.manifest?.scripts &&
        (project.manifest.scripts.preinstall || project.manifest.scripts.prepublish ||
          project.manifest.scripts.install ||
          project.manifest.scripts.postinstall ||
          project.manifest.scripts.prepare)
      ) {
        ctx.pendingBuilds.push(project.id)
      }

      if (scripts['prepublish']) { // tslint:disable-line:no-string-literal
        logger.warn({
          message: '`prepublish` scripts are deprecated. Use `prepare` for build steps and `prepublishOnly` for upload-only.',
          prefix: project.rootDir,
        })
      }
      projectsToInstall.push({
        pruneDirectDependencies: false,
        ...project,
        updatePackageManifest: opts.update === true,
        wantedDependencies,
      })
    }

    async function installSome (project: any) { // tslint:disable-line:no-any
      const currentPrefs = opts.ignoreCurrentPrefs ? {} : getAllDependenciesFromPackage(project.manifest)
      const optionalDependencies = project.targetDependenciesField ? {} : project.manifest.optionalDependencies || {}
      const devDependencies = project.targetDependenciesField ? {} : project.manifest.devDependencies || {}
      const wantedDeps = parseWantedDependencies(project.dependencySelectors, {
        allowNew: project.allowNew !== false,
        currentPrefs,
        defaultTag: opts.tag,
        dev: project.targetDependenciesField === 'devDependencies',
        devDependencies,
        optional: project.targetDependenciesField === 'optionalDependencies',
        optionalDependencies,
        updateWorkspaceDependencies: opts.update,
      })
      projectsToInstall.push({
        pruneDirectDependencies: false,
        ...project,
        wantedDependencies: wantedDeps.map(wantedDep => ({ ...wantedDep, isNew: true, updateSpec: true })),
      })
    }

    const equalLockfiles = lockfilesEqual(ctx.currentLockfile, ctx.wantedLockfile)
    const currentLockfileIsUpToDate = !ctx.existsWantedLockfile || equalLockfiles
    // Unfortunately, the private lockfile may differ from the public one.
    // A user might run named installations on a project that has a pnpm-lock.yaml file before running a noop install
    const makePartialCurrentLockfile = !installsOnly && (
      ctx.existsWantedLockfile && !ctx.existsCurrentLockfile ||
      // TODO: this operation is quite expensive. We'll have to find a better solution to do this.
      // maybe in pnpm v2 it won't be needed. See: https://github.com/pnpm/pnpm/issues/841
      !equalLockfiles
    )
    const result = await installInContext(projectsToInstall, ctx, {
      ...opts,
      currentLockfileIsUpToDate,
      makePartialCurrentLockfile,
      update: opts.update || !installsOnly,
      updateLockfileMinorVersion: true,
    })

    if (!opts.ignoreScripts) {
      await runLifecycleHooksConcurrently(['install', 'postinstall', 'prepublish', 'prepare'],
        projectsToBeInstalled,
        opts.childConcurrency,
        scriptsOpts,
      )
    }

    return result
  }
}

async function isExternalLink (storeDir: string, modules: string, pkgName: string) {
  const link = await isInnerLink(modules, pkgName)

  // checking whether the link is pointing to the store is needed
  // because packages are linked to store when independent-leaves = true
  return !link.isInner && !isSubdir(storeDir, link.target)
}

function pkgHasDependencies (manifest: ProjectManifest) {
  return Boolean(
    R.keys(manifest.dependencies).length ||
    R.keys(manifest.devDependencies).length ||
    R.keys(manifest.optionalDependencies).length,
  )
}

async function partitionLinkedPackages (
  dependencies: WantedDependency[],
  opts: {
    projectDir: string,
    lockfileOnly: boolean,
    modulesDir: string,
    storeDir: string,
    virtualStoreDir: string,
    workspacePackages?: WorkspacePackages,
  },
) {
  const nonLinkedDependencies: WantedDependency[] = []
  const linkedAliases = new Set<string>()
  for (const dependency of dependencies) {
    if (!dependency.alias || opts.workspacePackages?.[dependency.alias]) {
      nonLinkedDependencies.push(dependency)
      continue
    }
    const isInnerLink = await safeIsInnerLink(opts.modulesDir, dependency.alias, {
      hideAlienModules: opts.lockfileOnly === false,
      projectDir: opts.projectDir,
      storeDir: opts.storeDir,
      virtualStoreDir: opts.virtualStoreDir,
    })
    if (isInnerLink === true) {
      nonLinkedDependencies.push(dependency)
      continue
    }
    // This info-log might be better to be moved to the reporter
    logger.info({
      message: `${dependency.alias} is linked to ${opts.modulesDir} from ${isInnerLink}`,
      prefix: opts.projectDir,
    })
    linkedAliases.add(dependency.alias)
  }
  return {
    linkedAliases,
    nonLinkedDependencies,
  }
}

// If the specifier is new, the old resolution probably does not satisfy it anymore.
// By removing these resolutions we ensure that they are resolved again using the new specs.
function forgetResolutionsOfPrevWantedDeps (importer: ProjectSnapshot, wantedDeps: WantedDependency[]) {
  if (!importer.specifiers) return
  importer.dependencies = importer.dependencies || {}
  importer.devDependencies = importer.devDependencies || {}
  importer.optionalDependencies = importer.optionalDependencies || {}
  for (const { alias, pref } of wantedDeps) {
    if (alias && importer.specifiers[alias] !== pref) {
      if (importer.dependencies[alias]?.startsWith('link:') === false) {
        delete importer.dependencies[alias]
      }
      delete importer.devDependencies[alias]
      delete importer.optionalDependencies[alias]
    }
  }
}

async function linkedPackagesAreUpToDate (
  manifest: ProjectManifest,
  projectSnapshot: ProjectSnapshot,
  prefix: string,
  workspacePackages?: WorkspacePackages,
) {
  const workspacePackagesByDirectory = workspacePackages ? getWorkspacePackagesByDirectory(workspacePackages) : {}
  for (const depField of DEPENDENCIES_FIELDS) {
    const importerDeps = projectSnapshot[depField]
    const pkgDeps = manifest[depField]
    if (!importerDeps || !pkgDeps) continue
    const depNames = Object.keys(importerDeps)
    for (const depName of depNames) {
      if (!pkgDeps[depName]) continue
      const isLinked = importerDeps[depName].startsWith('link:')
      if (isLinked && (pkgDeps[depName].startsWith('link:') || pkgDeps[depName].startsWith('file:'))) continue
      const dir = isLinked
        ? path.join(prefix, importerDeps[depName].substr(5))
        : workspacePackages?.[depName]?.[importerDeps[depName]]?.dir
      if (!dir) continue
      const linkedPkg = workspacePackagesByDirectory[dir] || await safeReadPkgFromDir(dir)
      const availableRange = pkgDeps[depName].startsWith('workspace:') ? pkgDeps[depName].substr(10) : pkgDeps[depName]
      // This should pass the same options to semver as @pnpm/npm-resolver
      const localPackageSatisfiesRange = availableRange === '*' ||
        linkedPkg && semver.satisfies(linkedPkg.version, availableRange, { loose: true })
      if (isLinked !== localPackageSatisfiesRange) return false
    }
  }
  return true
}

function getWorkspacePackagesByDirectory (workspacePackages: WorkspacePackages) {
  const workspacePackagesByDirectory = {}
  Object.keys(workspacePackages || {}).forEach((pkgName) => {
    Object.keys(workspacePackages[pkgName] || {}).forEach((pkgVersion) => {
      workspacePackagesByDirectory[workspacePackages[pkgName][pkgVersion].dir] = workspacePackages[pkgName][pkgVersion].manifest
    })
  })
  return workspacePackagesByDirectory
}

function hasLocalTarballDepsInRoot (lockfile: Lockfile, importerId: string) {
  const importer = lockfile.importers?.[importerId]
  if (!importer) return false
  return R.any(refIsLocalTarball, R.values(importer.dependencies || {}))
    || R.any(refIsLocalTarball, R.values(importer.devDependencies || {}))
    || R.any(refIsLocalTarball, R.values(importer.optionalDependencies || {}))
}

function refIsLocalTarball (ref: string) {
  return ref.startsWith('file:') && (ref.endsWith('.tgz') || ref.endsWith('.tar.gz') || ref.endsWith('.tar'))
}

export async function addDependenciesToPackage (
  manifest: ProjectManifest,
  dependencySelectors: string[],
  opts: InstallOptions & {
    allowNew?: boolean,
    peer?: boolean,
    pinnedVersion?: 'major' | 'minor' | 'patch',
    targetDependenciesField?: DependenciesField,
  },
) {
  const projects = await mutateModules(
    [
      {
        allowNew: opts.allowNew,
        dependencySelectors,
        manifest,
        mutation: 'installSome',
        peer: opts.peer,
        pinnedVersion: opts.pinnedVersion,
        rootDir: opts.dir || process.cwd(),
        targetDependenciesField: opts.targetDependenciesField,
      },
    ],
    {
      ...opts,
      lockfileDir: opts.lockfileDir || opts.dir,
    })
  return projects[0].manifest
}

export type ImporterToUpdate = {
  binsDir: string,
  id: string,
  manifest: ProjectManifest,
  modulesDir: string,
  rootDir: string,
  pruneDirectDependencies: boolean,
  removePackages?: string[],
  updatePackageManifest: boolean,
  wantedDependencies: Array<WantedDependency & { isNew?: Boolean, updateSpec?: Boolean }>,
} & DependenciesMutation

async function installInContext (
  projects: ImporterToUpdate[],
  ctx: PnpmContext<DependenciesMutation>,
  opts: StrictInstallOptions & {
    makePartialCurrentLockfile: boolean,
    updateLockfileMinorVersion: boolean,
    preferredVersions?: PreferredVersions,
    currentLockfileIsUpToDate: boolean,
  },
) {
  if (opts.lockfileOnly && ctx.existsCurrentLockfile) {
    logger.warn({
      message: '`node_modules` is present. Lockfile only installation will make it out-of-date',
      prefix: ctx.lockfileDir,
    })
  }

  ctx.wantedLockfile.importers = ctx.wantedLockfile.importers || {}
  for (const { id } of projects) {
    if (!ctx.wantedLockfile.importers[id]) {
      ctx.wantedLockfile.importers[id] = { specifiers: {} }
    }
  }
  if (opts.pruneLockfileImporters) {
    const projectIds = new Set(projects.map(({ id }) => id))
    for (const wantedImporter of Object.keys(ctx.wantedLockfile.importers)) {
      if (!projectIds.has(wantedImporter)) {
        delete ctx.wantedLockfile.importers[wantedImporter]
      }
    }
  }

  await Promise.all(
    projects
      .map(async (project) => {
        if (project.mutation !== 'uninstallSome') return
        project.manifest = await removeDeps(project.manifest, project.dependencyNames, {
          prefix: project.rootDir,
          saveType: project.targetDependenciesField,
        })
      }),
  )

  stageLogger.debug({
    prefix: ctx.lockfileDir,
    stage: 'resolution_started',
  })

  const defaultUpdateDepth = (() => {
    if (opts.force) return Infinity
    if (opts.update) {
      return opts.depth
    }
    return -1
  })()
  const preferredVersions = opts.preferredVersions ?? (
    !opts.update &&
    ctx.wantedLockfile.packages &&
    !R.isEmpty(ctx.wantedLockfile.packages) &&
    getPreferredVersionsFromLockfile(ctx.wantedLockfile.packages!) || undefined
  )
  const _toResolveImporter = toResolveImporter.bind(null, {
    defaultUpdateDepth,
    lockfileOnly: opts.lockfileOnly,
    preferredVersions,
    storeDir: ctx.storeDir,
    virtualStoreDir: ctx.virtualStoreDir,
    workspacePackages: opts.workspacePackages,
  })
  const projectsToResolve = await Promise.all(projects.map((project) => _toResolveImporter(project)))
  const {
    dependenciesTree,
    outdatedDependencies,
    resolvedImporters,
    resolvedPackagesByPackageId,
    wantedToBeSkippedPackageIds,
  } = await resolveDependencies(
    projectsToResolve,
    {
      alwaysTryWorkspacePackages: opts.linkWorkspacePackages,
      currentLockfile: ctx.currentLockfile,
      dryRun: opts.lockfileOnly,
      engineStrict: opts.engineStrict,
      force: opts.force,
      hooks: opts.hooks,
      lockfileDir: opts.lockfileDir,
      nodeVersion: opts.nodeVersion,
      pnpmVersion: opts.packageManager.name === 'pnpm' ? opts.packageManager.version : '',
      registries: opts.registries,
      resolutionStrategy: opts.resolutionStrategy,
      sideEffectsCache: opts.sideEffectsCacheRead,
      storeController: opts.storeController,
      tag: opts.tag,
      updateLockfile: ctx.wantedLockfile.lockfileVersion !== LOCKFILE_VERSION || !opts.currentLockfileIsUpToDate,
      virtualStoreDir: ctx.virtualStoreDir,
      wantedLockfile: ctx.wantedLockfile,
      workspacePackages: opts.workspacePackages,
    },
  )

  stageLogger.debug({
    prefix: ctx.lockfileDir,
    stage: 'resolution_done',
  })

  const projectsToLink = await Promise.all<ProjectToLink>(projectsToResolve.map(async (project, index) => {
    const resolvedImporter = resolvedImporters[project.id]
    let newPkg: ProjectManifest | undefined = project.manifest
    if (project.updatePackageManifest) {
      newPkg = await updateProjectManifest(projectsToResolve[index], {
        directDependencies: resolvedImporter.directDependencies,
        preserveWorkspaceProtocol: opts.preserveWorkspaceProtocol,
        saveWorkspaceProtocol: opts.saveWorkspaceProtocol,
      })
    } else {
      packageManifestLogger.debug({
        prefix: project.rootDir,
        updated: project.manifest,
      })
    }

    if (newPkg) {
      const projectSnapshot = ctx.wantedLockfile.importers[project.id]
      ctx.wantedLockfile.importers[project.id] = addDirectDependenciesToLockfile(
        newPkg,
        projectSnapshot,
        resolvedImporter.linkedDependencies,
        resolvedImporter.directDependencies,
        ctx.registries,
      )
    }

    const topParents = project.manifest
      ? await getTopParents(
          R.difference(
            Object.keys(getAllDependenciesFromPackage(project.manifest)),
            resolvedImporter.directDependencies
              .filter((dep, index) => project.wantedDependencies[index].isNew === true)
              .map(({ alias }) => alias) || [],
          ),
          project.modulesDir,
        )
      : []

    return {
      binsDir: project.binsDir,
      directNodeIdsByAlias: resolvedImporter.directNodeIdsByAlias,
      id: project.id,
      linkedDependencies: resolvedImporter.linkedDependencies,
      manifest: newPkg || project.manifest,
      modulesDir: project.modulesDir,
      pruneDirectDependencies: project.pruneDirectDependencies,
      removePackages: project.removePackages,
      rootDir: project.rootDir,
      topParents,
    }
  }))

  const result = await linkPackages(
    projectsToLink,
    dependenciesTree,
    {
      afterAllResolvedHook: opts.hooks?.afterAllResolved,
      currentLockfile: ctx.currentLockfile,
      dryRun: opts.lockfileOnly,
      force: opts.force,
      hoistedAliases: ctx.hoistedAliases,
      hoistedModulesDir: ctx.hoistedModulesDir,
      hoistPattern: ctx.hoistPattern,
      include: opts.include,
      independentLeaves: opts.independentLeaves,
      lockfileDir: opts.lockfileDir,
      makePartialCurrentLockfile: opts.makePartialCurrentLockfile,
      outdatedDependencies,
      pruneStore: opts.pruneStore,
      registries: ctx.registries,
      sideEffectsCacheRead: opts.sideEffectsCacheRead,
      skipped: ctx.skipped,
      storeController: opts.storeController,
      strictPeerDependencies: opts.strictPeerDependencies,
      updateLockfileMinorVersion: opts.updateLockfileMinorVersion,
      virtualStoreDir: ctx.virtualStoreDir,
      wantedLockfile: ctx.wantedLockfile,
      wantedToBeSkippedPackageIds,
    },
  )

  ctx.pendingBuilds = ctx.pendingBuilds
    .filter((relDepPath) => !result.removedDepPaths.has(dp.resolve(ctx.registries, relDepPath)))

  if (opts.ignoreScripts) {
    // we can use concat here because we always only append new packages, which are guaranteed to not be there by definition
    ctx.pendingBuilds = ctx.pendingBuilds
      .concat(
        result.newDepPaths
          .filter((depPath) => result.depGraph[depPath].requiresBuild)
          .map((depPath) => dp.relative(ctx.registries, result.depGraph[depPath].name, depPath)),
      )
  }

  if (!opts.lockfileOnly) {
    // postinstall hooks
    if (!opts.ignoreScripts && result.newDepPaths?.length) {
      const depPaths = Object.keys(result.depGraph)
      const rootNodes = depPaths.filter((depPath) => result.depGraph[depPath].depth === 0)

      await buildModules(result.depGraph, rootNodes, {
        childConcurrency: opts.childConcurrency,
        depsToBuild: new Set(result.newDepPaths),
        extraBinPaths: ctx.extraBinPaths,
        lockfileDir: ctx.lockfileDir,
        optional: opts.include.optionalDependencies,
        rawConfig: opts.rawConfig,
        rootNodeModulesDir: ctx.virtualStoreDir,
        sideEffectsCacheWrite: opts.sideEffectsCacheWrite,
        storeController: opts.storeController,
        unsafePerm: opts.unsafePerm,
        userAgent: opts.userAgent,
      })
    }

    if (result.newDepPaths?.length) {
      const newPkgs = R.props<string, DependenciesGraphNode>(result.newDepPaths, result.depGraph)
      await linkAllBins(newPkgs, result.depGraph, {
        optional: opts.include.optionalDependencies,
        warn: (message: string) => logger.warn({ message, prefix: opts.lockfileDir }),
      })
    }

    if (!opts.lockfileOnly) {
      await Promise.all(projectsToLink.map(linkBinsOfImporter))
    }
  }

  // waiting till the skipped packages are downloaded to the store
  await Promise.all(
    R.props<string, ResolvedPackage>(Array.from(ctx.skipped), resolvedPackagesByPackageId)
      // skipped packages might have not been reanalized on a repeat install
      // so lets just ignore those by excluding nulls
      .filter(Boolean)
      .map(({ fetchingFiles }) => fetchingFiles()),
  )

  // waiting till package requests are finished
  await Promise.all(R.values(resolvedPackagesByPackageId).map(({ finishing }) => finishing()))

  const lockfileOpts = { forceSharedFormat: opts.forceSharedLockfile }
  if (opts.lockfileOnly) {
    await writeWantedLockfile(ctx.lockfileDir, result.wantedLockfile, lockfileOpts)
  } else {
    await Promise.all([
      opts.useLockfile
        ? writeLockfiles({
          currentLockfile: result.currentLockfile,
          currentLockfileDir: ctx.virtualStoreDir,
          wantedLockfile: result.wantedLockfile,
          wantedLockfileDir: ctx.lockfileDir,
          ...lockfileOpts,
        })
        : writeCurrentLockfile(ctx.virtualStoreDir, result.currentLockfile, lockfileOpts),
      (() => {
        if (result.currentLockfile.packages === undefined && result.removedDepPaths.size === 0) {
          return Promise.resolve()
        }
        return writeModulesYaml(ctx.rootModulesDir, {
          ...ctx.modulesFile,
          hoistedAliases: result.newHoistedAliases,
          hoistPattern: ctx.hoistPattern,
          included: ctx.include,
          independentLeaves: ctx.independentLeaves,
          layoutVersion: LAYOUT_VERSION,
          packageManager: `${opts.packageManager.name}@${opts.packageManager.version}`,
          pendingBuilds: ctx.pendingBuilds,
          registries: ctx.registries,
          shamefullyHoist: ctx.shamefullyHoist,
          skipped: Array.from(ctx.skipped),
          store: ctx.storeDir,
          virtualStoreDir: ctx.virtualStoreDir,
        })
      })(),
    ])
  }

  summaryLogger.debug({ prefix: opts.lockfileDir })

  await opts.storeController.close()

  return projectsToLink.map(({ manifest, rootDir }) => ({ rootDir, manifest }))
}

async function toResolveImporter (
  opts: {
    defaultUpdateDepth: number,
    lockfileOnly: boolean,
    storeDir: string,
    virtualStoreDir: string,
    preferredVersions?: PreferredVersions,
    workspacePackages: WorkspacePackages,
  },
  project: ImporterToUpdate,
) {
  const allDeps = getWantedDependencies(project.manifest)
  const { linkedAliases, nonLinkedDependencies } = await partitionLinkedPackages(allDeps, {
    lockfileOnly: opts.lockfileOnly,
    modulesDir: project.modulesDir,
    projectDir: project.rootDir,
    storeDir: opts.storeDir,
    virtualStoreDir: opts.virtualStoreDir,
    workspacePackages: opts.workspacePackages,
  })
  const existingDeps = nonLinkedDependencies
    .filter(({ alias }) => !project.wantedDependencies.some((wantedDep) => wantedDep.alias === alias))
  let wantedDependencies!: Array<WantedDependency & { isNew?: boolean, updateDepth: number }>
  if (!project.manifest) {
    wantedDependencies = [
      ...project.wantedDependencies,
      ...existingDeps,
    ]
    .map((dep) => ({
      ...dep,
      updateDepth: opts.defaultUpdateDepth,
    }))
  } else {
    wantedDependencies = [
      ...project.wantedDependencies.map((dep) => ({ ...dep, updateDepth: opts.defaultUpdateDepth })),
      ...existingDeps.map((dep) => ({ ...dep, updateDepth: -1 })),
    ]
  }
  return {
    ...project,
    preferredVersions: opts.preferredVersions ?? (project.manifest && getPreferredVersionsFromPackage(project.manifest)) ?? {},
    wantedDependencies: wantedDependencies
      .filter(({ alias, updateDepth }) => updateDepth >= 0 || !linkedAliases.has(alias)),
  }
}

const limitLinking = pLimit(16)

function linkBinsOfImporter ({ modulesDir, binsDir, rootDir }: ProjectToLink) {
  const warn = (message: string) => logger.warn({ message, prefix: rootDir })
  return linkBins(modulesDir, binsDir, { allowExoticManifests: true, warn })
}

async function linkAllBins (
  depNodes: DependenciesGraphNode[],
  depGraph: DependenciesGraph,
  opts: {
    optional: boolean,
    warn: (message: string) => void,
  },
) {
  return Promise.all(
    depNodes.map((depNode => limitLinking(async () => linkBinsOfDependencies(depNode, depGraph, opts)))),
  )
}

function addDirectDependenciesToLockfile (
  newManifest: ProjectManifest,
  projectSnapshot: ProjectSnapshot,
  linkedPackages: Array<{alias: string}>,
  directDependencies: Array<{
    alias: string,
    optional: boolean,
    dev: boolean,
    resolution: Resolution,
    id: string,
    version: string,
    name: string,
    normalizedPref?: string,
  }>,
  registries: Registries,
): ProjectSnapshot {
  const newProjectSnapshot = {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    specifiers: {},
  }

  linkedPackages.forEach((linkedPkg) => {
    newProjectSnapshot.specifiers[linkedPkg.alias] = getSpecFromPackageManifest(newManifest, linkedPkg.alias)
  })

  const directDependenciesByAlias = directDependencies.reduce((acc, directDependency) => {
    acc[directDependency.alias] = directDependency
    return acc
  }, {})

  const optionalDependencies = R.keys(newManifest.optionalDependencies)
  const dependencies = R.difference(R.keys(newManifest.dependencies), optionalDependencies)
  const devDependencies = R.difference(R.difference(R.keys(newManifest.devDependencies), optionalDependencies), dependencies)
  const allDeps = [
    ...optionalDependencies,
    ...devDependencies,
    ...dependencies,
  ]

  for (const alias of allDeps) {
    if (directDependenciesByAlias[alias]) {
      const dep = directDependenciesByAlias[alias]
      const ref = absolutePathToRef(dep.id, {
        alias: dep.alias,
        realName: dep.name,
        registries,
        resolution: dep.resolution,
      })
      if (dep.dev) {
        newProjectSnapshot.devDependencies[dep.alias] = ref
      } else if (dep.optional) {
        newProjectSnapshot.optionalDependencies[dep.alias] = ref
      } else {
        newProjectSnapshot.dependencies[dep.alias] = ref
      }
      newProjectSnapshot.specifiers[dep.alias] = getSpecFromPackageManifest(newManifest, dep.alias)
    } else if (projectSnapshot.specifiers[alias]) {
      newProjectSnapshot.specifiers[alias] = projectSnapshot.specifiers[alias]
      if (projectSnapshot.dependencies?.[alias]) {
        newProjectSnapshot.dependencies[alias] = projectSnapshot.dependencies[alias]
      } else if (projectSnapshot.optionalDependencies?.[alias]) {
        newProjectSnapshot.optionalDependencies[alias] = projectSnapshot.optionalDependencies[alias]
      } else if (projectSnapshot.devDependencies?.[alias]) {
        newProjectSnapshot.devDependencies[alias] = projectSnapshot.devDependencies[alias]
      }
    }
  }

  alignDependencyTypes(newManifest, newProjectSnapshot)

  return newProjectSnapshot
}

function alignDependencyTypes (manifest: ProjectManifest, projectSnapshot: ProjectSnapshot) {
  const depTypesOfAliases = getAliasToDependencyTypeMap(manifest)

  // Aligning the dependency types in pnpm-lock.yaml
  for (const depType of DEPENDENCIES_FIELDS) {
    if (!projectSnapshot[depType]) continue
    for (const alias of Object.keys(projectSnapshot[depType] || {})) {
      if (depType === depTypesOfAliases[alias] || !depTypesOfAliases[alias]) continue
      projectSnapshot[depTypesOfAliases[alias]][alias] = projectSnapshot[depType]![alias]
      delete projectSnapshot[depType]![alias]
    }
  }
}

function getAliasToDependencyTypeMap (manifest: ProjectManifest) {
  const depTypesOfAliases = {}
  for (const depType of DEPENDENCIES_FIELDS) {
    if (!manifest[depType]) continue
    for (const alias of Object.keys(manifest[depType] || {})) {
      if (!depTypesOfAliases[alias]) {
        depTypesOfAliases[alias] = depType
      }
    }
  }
  return depTypesOfAliases
}

async function getTopParents (pkgNames: string[], modules: string) {
  const pkgs = await Promise.all(
    pkgNames.map((pkgName) => path.join(modules, pkgName)).map(safeReadPkgFromDir),
  )
  return (
    pkgs
    .filter(Boolean) as DependencyManifest[]
  )
    .map(({ name, version }: DependencyManifest) => ({ name, version }))
}
