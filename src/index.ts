import { AchievementsCoreAdapter } from '@st-achievements/core';
import { StFirebaseApp } from '@st-api/firebase';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

import { AppHandler, appHandler } from './app.handler.js';

dayjs.extend(customParseFormat);

const app = StFirebaseApp.create({
  secrets: [],
  adapter: new AchievementsCoreAdapter({
    throttling: false,
    authentication: false,
  }),
  providers: [AppHandler],
  controllers: [],
}).addPubSub(appHandler);

export const usr_workout = {
  processor: {
    events: app.getCloudEventHandlers(),
    http: app.getHttpHandler(),
  },
};
