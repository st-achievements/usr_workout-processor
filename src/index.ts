import { AchievementsCoreAdapter } from '@st-achievements/core';
import { StFirebaseApp } from '@st-api/firebase';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

import { appHandler } from './app.handler.js';
import { AppModule } from './app.module.js';

dayjs.extend(customParseFormat);

const app = StFirebaseApp.create(AppModule, {
  secrets: [],
  adapter: new AchievementsCoreAdapter(),
}).addPubSub(appHandler);

export const usr_workout = {
  processor: {
    events: app.getCloudEventHandlers(),
    http: app.getHttpHandler(),
  },
};
