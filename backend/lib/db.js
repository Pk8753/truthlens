import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { PROJECT_ID, FIRESTORE_DATABASE_ID } from './config.js';

export const db = new Firestore({
  ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
  databaseId: FIRESTORE_DATABASE_ID,
  ignoreUndefinedProperties: true
});

export const gcs = new Storage({
  ...(PROJECT_ID ? { projectId: PROJECT_ID } : {})
});
