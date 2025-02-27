import createResolver, { ResolveFunction } from '@pnpm/default-resolver'
import { DependencyManifest, Registries } from '@pnpm/types'
import { pickRegistryForPackage } from '@pnpm/utils'
import LRU = require('lru-cache')

export function createLatestManifestGetter (
  opts: {
    ca?: string,
    cert?: string,
    fetchRetries?: number,
    fetchRetryFactor?: number,
    fetchRetryMaxtimeout?: number,
    fetchRetryMintimeout?: number,
    httpsProxy?: string,
    key?: string,
    localAddress?: string,
    lockfileDir: string,
    offline?: boolean,
    dir: string,
    proxy?: string,
    rawConfig: object,
    registries: Registries,
    storeDir: string,
    strictSsl?: boolean,
    userAgent?: string,
    verifyStoreIntegrity?: boolean,
  },
): (packageName: string, pref: string) => Promise<DependencyManifest | null> {
  const resolve = createResolver(Object.assign(opts, {
    fullMetadata: true,
    metaCache: new LRU({
      max: 10000,
      maxAge: 120 * 1000, // 2 minutes
    }) as any, // tslint:disable-line:no-any
  }))
  return getLatestManifest.bind(null, resolve, opts)
}

export async function getLatestManifest (
  resolve: ResolveFunction,
  opts: {
    lockfileDir: string,
    dir: string,
    registries: Registries,
  },
  packageName: string,
  pref: string,
) {
  const resolution = await resolve({ alias: packageName, pref }, {
    lockfileDir: opts.lockfileDir,
    preferredVersions: {},
    projectDir: opts.dir,
    registry: pickRegistryForPackage(opts.registries, packageName),
  })
  return resolution && resolution.manifest || null
}
