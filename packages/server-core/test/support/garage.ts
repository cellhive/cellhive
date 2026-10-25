import { fileURLToPath } from 'node:url';

import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

const REPO_ROOT = new URL('../../../../', import.meta.url);

/** DEV-ONLY credentials shared with docker-compose.dev.yml / .env.example. */
export const GARAGE_TEST_CREDENTIALS = {
  region: 'garage',
  bucket: 'cellhive',
  accessKeyId: 'GK6465762d6f70656e62617365',
  secretAccessKey: '6465762d6f6e6c792d73332d7365637265742d646f2d6e6f742d757365212121',
  /** `admin_token` of infra/garage/garage.toml. */
  adminToken: 'dev-only-garage-admin-token',
} as const;

export interface StartedGarage {
  /** `http://<host>:<port>` of the S3 API as seen from the test process. */
  readonly s3Endpoint: string;
  readonly host: string;
  readonly s3Port: number;
  stop(): Promise<void>;
}

/**
 * Starts Garage with the repository's dev configuration and initialises it
 * with the real `infra/garage/storage-init.sh` (layout, bucket, key, CORS),
 * run in the same curl image docker-compose uses.
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
      // The image is distroless (no shell): wait for any answer of the admin API.
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
        GARAGE_ADMIN_TOKEN: GARAGE_TEST_CREDENTIALS.adminToken,
        S3_BUCKET: GARAGE_TEST_CREDENTIALS.bucket,
        S3_REGION: GARAGE_TEST_CREDENTIALS.region,
        S3_ACCESS_KEY_ID: GARAGE_TEST_CREDENTIALS.accessKeyId,
        S3_SECRET_ACCESS_KEY: GARAGE_TEST_CREDENTIALS.secretAccessKey,
        PUBLIC_URL: 'http://localhost:5173',
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
  const s3Port = started.getMappedPort(3900);
  return {
    s3Endpoint: `http://${host}:${String(s3Port)}`,
    host,
    s3Port,
    async stop() {
      await started.stop();
      await network.stop();
    },
  };
}
