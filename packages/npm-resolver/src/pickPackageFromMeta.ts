import { VersionSelectors } from '@pnpm/resolver-base'
import semver = require('semver')
import { RegistryPackageSpec } from './parsePref'
import { PackageInRegistry, PackageMeta } from './pickPackage'

export default function (
  spec: RegistryPackageSpec,
  preferredVersionSelectors: VersionSelectors | undefined,
  meta: PackageMeta,
): PackageInRegistry {
  let version!: string
  switch (spec.type) {
    case 'version':
      version = spec.fetchSpec
      break
    case 'tag':
      version = meta['dist-tags'][spec.fetchSpec]
      break
    case 'range':
      version = pickVersionByVersionRange(meta, spec.fetchSpec, preferredVersionSelectors)
      break
  }
  return meta.versions[version]
}

function pickVersionByVersionRange (
  meta: PackageMeta,
  versionRange: string,
  preferredVerSels?: VersionSelectors,
) {
  let versions: string[] | undefined
  const latest = meta['dist-tags'].latest

  const preferredVerSelsArr = Object.entries(preferredVerSels || {})
  if (preferredVerSelsArr.length) {
    const preferredVersions: string[] = []
    for (const [preferredSelector, preferredSelectorType] of preferredVerSelsArr) {
      if (preferredSelector === versionRange) continue
      switch (preferredSelectorType) {
        case 'tag': {
          preferredVersions.push(meta['dist-tags'][preferredSelector])
          break
        }
        case 'range': {
          // This might be slow if there are many versions
          // and the package is an indirect dependency many times in the project.
          // If it will create noticable slowdown, then might be a good idea to add some caching
          versions = Object.keys(meta.versions)
          for (const version of versions) {
            if (semver.satisfies(version, preferredSelector, true)) {
              preferredVersions.push(version)
            }
          }
          break
        }
        case 'version': {
          if (meta.versions[preferredSelector]) {
            preferredVersions.push(preferredSelector)
          }
          break
        }
      }
    }

    if (preferredVersions.includes(latest) && semver.satisfies(latest, versionRange, true)) {
      return latest
    }
    const preferredVersion = semver.maxSatisfying(preferredVersions, versionRange, true)
    if (preferredVersion) {
      return preferredVersion
    }
  }

  // Not using semver.satisfies in case of * because it does not select beta versions.
  // E.g.: 1.0.0-beta.1. See issue: https://github.com/pnpm/pnpm/issues/865
  if (versionRange === '*' || semver.satisfies(latest, versionRange, true)) {
    return latest
  }
  versions = versions || Object.keys(meta.versions)

  const maxVersion = semver.maxSatisfying(versions, versionRange, true)

  // if the selected version is deprecated, try to find a non-deprecated one that satisfies the range
  if (maxVersion && meta.versions[maxVersion].deprecated && versions.length > 1) {
    const nonDeprecatedVersions = versions.map((version) => meta.versions[version])
      .filter((versionMeta) => !versionMeta.deprecated)
      .map((versionMeta) => versionMeta.version)

    const maxNonDeprecatedVersion = semver.maxSatisfying(nonDeprecatedVersions, versionRange, true)
    if (maxNonDeprecatedVersion) return maxNonDeprecatedVersion
  }
  return maxVersion
}
