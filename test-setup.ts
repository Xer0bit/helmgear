/**
 * Remove machine settings that change behaviour from every test process, so the
 * host cannot decide a test outcome. A test that needs one sets it explicitly.
 * - Proxy variables: an ambient HTTP_PROXY would reroute requests.
 * - NoDefaultCurrentDirectoryInExePath: some agent hosts set it, and it stops
 *   Windows executable lookup from searching the current directory.
 */
import { PROXY_ENV_NAMES } from './packages/util/http-proxy/src/policy.ts'

for (const name of [...PROXY_ENV_NAMES, 'NODE_USE_ENV_PROXY', 'NoDefaultCurrentDirectoryInExePath']) Reflect.deleteProperty(process.env, name)
