import { Module } from '@nestjs/common';
import { DrizzleOrmModule } from '@st-achievements/database';
import { CoreModule } from '@st-api/core';
import { FirebaseAdminModule, PubSubModule } from '@st-api/firebase';

import { AppHandler } from './app.handler.js';

@Module({
  imports: [
    CoreModule.forRoot(),
    FirebaseAdminModule.forRoot(),
    DrizzleOrmModule,
    PubSubModule,
  ],
  controllers: [],
  providers: [AppHandler],
})
export class AppModule {}
