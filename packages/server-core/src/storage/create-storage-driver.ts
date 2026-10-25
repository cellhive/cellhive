import { LocalStorageDriver } from './local-driver.js';
import { S3StorageDriver } from './s3-driver.js';

import type { StorageDriver } from './storage-driver.js';
import type { AppConfig } from '../config/load-config.js';

/** Builds the driver selected by STORAGE_DRIVER (SPEC §20). */
export function createStorageDriver(config: AppConfig): StorageDriver {
  const storage = config.storage;
  if (storage.driver === 's3') {
    return new S3StorageDriver({
      endpoint: storage.endpoint,
      publicEndpoint: storage.publicEndpoint,
      region: storage.region,
      bucket: storage.bucket,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      forcePathStyle: storage.forcePathStyle,
    });
  }
  return new LocalStorageDriver({
    root: storage.path,
    publicUrl: config.publicUrl,
    sessionSecret: config.security.sessionSecret,
  });
}
