import { Module } from '@nestjs/common';
import { AchievementsCoreModule } from '@st-achievements/core';
import { DrizzleOrmModule } from '@st-achievements/database';
import { CoreModule } from '@st-api/core';

import { AppHandler } from './app.handler.js';

@Module({
  imports: [
    CoreModule.forRoot(),
    AchievementsCoreModule.forRoot({
      throttling: false,
      authentication: false,
    }),
    DrizzleOrmModule,
  ],
  controllers: [],
  providers: [AppHandler],
})
export class AppModule {}
