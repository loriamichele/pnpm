import { docsUrl, readProjectManifestOnly } from '@pnpm/cli-utils'
import { FILTERING, UNIVERSAL_OPTIONS } from '@pnpm/common-cli-options-help'
import { Config, types as allTypes } from '@pnpm/config'
import { LogBase } from '@pnpm/logger'
import {
  createOrConnectStoreController,
  CreateStoreControllerOptions,
} from '@pnpm/store-connection-manager'
import { oneLine } from 'common-tags'
import R = require('ramda')
import renderHelp = require('render-help')
import {
  rebuild,
  rebuildPkgs,
} from './implementation'
import recursive from './recursive'

export function rcOptionsTypes () {
  return {}
}

export function cliOptionsTypes () {
  return {
    ...R.pick([
      'unsafe-perm',
    ], allTypes),
    'pending': Boolean,
  }
}

export const commandNames = ['rebuild', 'rb']

export function help () {
  return renderHelp({
    aliases: ['rb'],
    description: 'Rebuild a package.',
    descriptionLists: [
      {
        title: 'Options',

        list: [
          {
            description: oneLine`Rebuild every package found in subdirectories
              or every workspace package, when executed inside a workspace.
              For options that may be used with \`-r\`, see "pnpm help recursive"`,
            name: '--recursive',
            shortAlias: '-r',
          },
          {
            description: 'Rebuild packages that were not build during installation. Packages are not build when installing with the --ignore-scripts flag',
            name: '--pending',
          },
          ...UNIVERSAL_OPTIONS,
        ],
      },
      FILTERING,
    ],
    url: docsUrl('rebuild'),
    usages: ['pnpm rebuild [<pkg> ...]'],
  })
}

export async function handler (
  args: string[],
  opts: Pick<Config,
    'allProjects' |
    'dir' |
    'engineStrict' |
    'independentLeaves' |
    'rawLocalConfig' |
    'registries' |
    'selectedProjectsGraph' |
    'sideEffectsCache' |
    'sideEffectsCacheReadonly' |
    'workspaceDir'
  > &
    CreateStoreControllerOptions &
    {
      recursive?: boolean,
      reporter?: (logObj: LogBase) => void,
      pending: boolean,
    },
) {
  if (opts.recursive && opts.allProjects && opts.selectedProjectsGraph && opts.workspaceDir) {
    await recursive(opts.allProjects, args, { ...opts, selectedProjectsGraph: opts.selectedProjectsGraph!, workspaceDir: opts.workspaceDir! })
    return
  }
  const store = await createOrConnectStoreController(opts)
  const rebuildOpts = Object.assign(opts, {
    sideEffectsCacheRead: opts.sideEffectsCache || opts.sideEffectsCacheReadonly,
    sideEffectsCacheWrite: opts.sideEffectsCache,
    storeController: store.ctrl,
    storeDir: store.dir,
  })

  if (args.length === 0) {
    await rebuild(
      [
        {
          buildIndex: 0,
          manifest: await readProjectManifestOnly(rebuildOpts.dir, opts),
          rootDir: rebuildOpts.dir,
        },
      ],
      rebuildOpts,
    )
  }
  await rebuildPkgs(
    [
      {
        manifest: await readProjectManifestOnly(rebuildOpts.dir, opts),
        rootDir: rebuildOpts.dir,
      },
    ],
    args,
    rebuildOpts,
  )
}
