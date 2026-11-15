/**
 * Public package manifest and plugin display types, with no runtime exports.
 * @module @helmgear/package-manifest
 */

export type {
  ClientModuleStylesheetDescriptor,
  ClientModuleStyleContext,
  ClientModuleMeta,
  ClientModuleMetaFactory,
  ClientBundleRequire,
  ClientModuleFactory,
  HelmgearClientModuleManifest,
} from './client-module.ts'

export type {
  HelmgearBundleManifest,
  HelmgearClientManifest,
  HelmgearEnginesManifest,
  HelmgearManifest,
  HelmgearPackageManifest,
  HelmgearProfileManifest,
  LocalizedText,
  PluginLocalizedMeta,
} from './types.ts'
