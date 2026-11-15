/**
 * Remove the machine's proxy configuration from every test process, so an
 * ambient HTTP_PROXY cannot decide a test outcome. A test that needs a proxy
 * sets exactly the names it means to exercise.
 */
import { PROXY_ENV_NAMES } from './packages/util/http-proxy/src/policy.ts'

for (const name of [...PROXY_ENV_NAMES, 'NODE_USE_ENV_PROXY']) Reflect.deleteProperty(process.env, name)
