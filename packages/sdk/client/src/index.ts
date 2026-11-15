/**
 * TypeScript client SDK for the Helmgear runtime: spawn the
 * same-version `helmgear --profile sdk` runtime as a subprocess and drive agent
 * turns over stdio JSON-RPC. `Helmgear` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; named profiles and ordered patch
 * files customize the runtime process it spawns.
 *
 * @module @helmgear/sdk-client
 */

export { Helmgear, HarnessSession, validatedSessionEvent } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@helmgear/sdk-protocol'
export type {
  ContentBlock,
  SdkEncodedImageBlock,
  SdkPromptContentBlock,
  SdkUserQuestionAnswer,
  SdkUserQuestionResult,
  SdkUserQuestionRequest,
  HelmgearOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
