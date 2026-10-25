import { fileURLToPath } from 'node:url';

import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

import { TEST_PUBLIC_URL } from './support.js';

const REPO_ROOT = new URL('../../../../', import.meta.url);

/** DEV-ONLY credentials shared with docker-compose.dev.yml / .env.example. */
export const GARAGE_CREDENTIALS = {
  region: 'garage',
  bucket: 'cellhive',
  accessKeyId: 'GK6465762d6f70656e62617365',
  secretAccessKey: '6465762d6f6e6c792d73332d7365637265742d646f2d6e6f742d757365212121',
  adminToken: 'dev-only-garage-admin-token',
} as const;

export interface StartedGarage {
  /** S3 endpoint as the API reaches it (`S3_ENDPOINT`). */
  readonly endpoint: string;
  /**
   * The same Garage under another host name (`S3_PUBLIC_ENDPOINT`): what
   * browsers would reach through a reverse proxy. SigV4 signs the host, so
   * URLs signed for it work only through it.
   */
  readonly publicEndpoint: string;
  stop(): Promise<void>;
}

/**
 * A throwaway Garage (ADR-0016, never the dev one) initialised by the real
 * `infra/garage/storage-init.sh`, with CORS for `TEST_PUBLIC_URL`.
 */
export async function startGarage(): Promise<StartedGarage> {
  const network: StartedNetwork = await new Network().start();
  let garage: StartedTestContainer | undefined;
  try {
    garage = await new GenericContainer('dxflrs/garage:v2.4.1')
      .withNetwork(network)
      .withNetworkAliases('garage')
      .withCopyFilesToContainer([
        {
          source: fileURLToPath(new URL('infra/garage/garage.toml', REPO_ROOT)),
          target: '/etc/garage.toml',
        },
      ])
      .withExposedPorts(3900, 3903)
      .withWaitStrategy(Wait.forHttp('/health', 3903).forStatusCodeMatching(() => true))
      .start();
    await new GenericContainer('curlimages/curl:8.22.0')
      .withNetwork(network)
      .withCopyFilesToContainer([
        {
          source: fileURLToPath(new URL('infra/garage/storage-init.sh', REPO_ROOT)),
          target: '/storage-init.sh',
        },
      ])
      .withEntrypoint(['/bin/sh', '/storage-init.sh'])
      .withEnvironment({
        GARAGE_ADMIN_URL: 'http://garage:3903',
        GARAGE_S3_URL: 'http://garage:3900',
        GARAGE_ADMIN_TOKEN: GARAGE_CREDENTIALS.adminToken,
        S3_BUCKET: GARAGE_CREDENTIALS.bucket,
        S3_REGION: GARAGE_CREDENTIALS.region,
        S3_ACCESS_KEY_ID: GARAGE_CREDENTIALS.accessKeyId,
        S3_SECRET_ACCESS_KEY: GARAGE_CREDENTIALS.secretAccessKey,
        PUBLIC_URL: TEST_PUBLIC_URL,
      })
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    await garage?.stop();
    await network.stop();
    throw error;
  }
  const started = garage;
  const host = started.getHost();
  const port = started.getMappedPort(3900);
  const publicHost = host === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  return {
    endpoint: `http://${host}:${String(port)}`,
    publicEndpoint: `http://${publicHost}:${String(port)}`,
    async stop() {
      await started.stop();
      await network.stop();
    },
  };
}

/** Environment of an API using `garage` as object storage. */
export function garageEnv(garage: StartedGarage): Record<string, string> {
  return {
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: garage.endpoint,
    S3_PUBLIC_ENDPOINT: garage.publicEndpoint,
    S3_REGION: GARAGE_CREDENTIALS.region,
    S3_BUCKET: GARAGE_CREDENTIALS.bucket,
    S3_ACCESS_KEY_ID: GARAGE_CREDENTIALS.accessKeyId,
    S3_SECRET_ACCESS_KEY: GARAGE_CREDENTIALS.secretAccessKey,
    S3_FORCE_PATH_STYLE: 'true',
  };
}
