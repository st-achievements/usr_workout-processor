import { Injectable } from '@nestjs/common';
import { cfg, Drizzle, usr, wrk } from '@st-achievements/database';
import {
  createPubSubHandler,
  Eventarc,
  Logger,
  PubSubEventData,
  PubSubHandler,
} from '@st-api/firebase';
import { and, asc, eq, gte, lte, or } from 'drizzle-orm';

import {
  WORKOUT_CREATED_EVENT,
  WORKOUT_PROCESSOR_QUEUE,
  WORKOUT_TYPE_OTHER_ID,
} from './app.constants.js';
import { WorkoutEventDto } from './workout-event.dto.js';
import { WorkoutInputDto } from './workout-input.dto.js';
import dayjs from 'dayjs';
import { PERIOD_NOT_FOUND } from './exceptions.js';

@Injectable()
export class AppHandler implements PubSubHandler<typeof WorkoutInputDto> {
  constructor(
    private readonly eventarc: Eventarc,
    private readonly drizzle: Drizzle,
  ) {}

  private readonly logger = Logger.create(this);

  async handle(event: PubSubEventData<typeof WorkoutInputDto>): Promise<void> {
    this.logger.info('event', { event });

    const workoutExists = await this.drizzle.query.usrWorkout.findFirst({
      where: eq(usr.workout.externalId, event.data.id),
      columns: {
        id: true,
      },
    });

    if (workoutExists) {
      this.logger.info(
        `workout with externalId ${event.data.id} already created!`,
      );
      return;
    }

    const user = await this.drizzle.query.usrUser.findFirst({
      where: and(
        eq(usr.user.name, event.data.username),
        eq(usr.user.active, true),
      ),
      columns: {
        id: true,
      },
    });

    if (!user) {
      this.logger.warn(`username ${event.data.username} not found`);
      return;
    }

    const startAt = dayjs(event.data.startTime).format('YYYY-MM-DD');
    const endAt = dayjs(event.data.endTime).format('YYYY-MM-DD');

    const period = await this.drizzle.query.cfgPeriod.findFirst({
      where: and(
        gte(cfg.period.startAt, startAt),
        lte(cfg.period.endAt, endAt),
        eq(cfg.period.active, true),
      ),
      orderBy: [asc(cfg.period.startAt), asc(cfg.period.endAt)],
      columns: {
        id: true,
      },
    });

    if (!period) {
      throw PERIOD_NOT_FOUND(
        `Period for startAt ${startAt} and endAt ${endAt} not found`,
      );
    }

    const workoutTypes = await this.drizzle.query.wrkWorkoutType.findMany({
      where: and(
        eq(wrk.workoutType.active, true),
        and(
          or(
            eq(wrk.workoutType.name, event.data.workoutActivityType),
            eq(wrk.workoutType.id, WORKOUT_TYPE_OTHER_ID),
          ),
        ),
      ),
      columns: {
        id: true,
        name: true,
      },
    });

    const workoutTypeFromEvent = workoutTypes.find(
      (workout) => workout.name === event.data.workoutActivityType,
    );
    const workoutTypeOther = workoutTypes.find(
      (workout) => workout.id === WORKOUT_TYPE_OTHER_ID,
    );

    if (!workoutTypeFromEvent) {
      this.logger.warn(
        `could not find workout type for ${event.data.workoutActivityType}. Will use id = ${WORKOUT_TYPE_OTHER_ID}`,
      );
    }

    const workout = workoutTypeFromEvent ?? workoutTypeOther;

    if (!workout) {
      this.logger.warn(
        `could not find workout type for ${event.data.workoutActivityType} and also not found workout id = ${WORKOUT_TYPE_OTHER_ID}`,
      );
      return;
    }

    const [userWorkout] = await this.drizzle
      .insert(usr.workout)
      .values({
        duration: event.data.duration,
        externalId: event.data.id,
        distance: event.data.totalDistance,
        endedAt: event.data.endTime,
        userId: user.id,
        startedAt: event.data.startTime,
        energyBurned: event.data.totalEnergyBurned,
        workoutName: workoutTypeFromEvent
          ? null
          : event.data.workoutActivityType,
        workoutTypeId: workout.id,
        periodId: period.id,
      })
      .returning();

    if (!userWorkout) {
      this.logger.error('failed to insert usr.workout');
      return;
    }

    const eventData: WorkoutEventDto = {
      duration: userWorkout.duration,
      externalId: userWorkout.externalId,
      energyBurned: userWorkout.energyBurned,
      startedAt: userWorkout.startedAt.toISOString(),
      userId: userWorkout.userId,
      distance: userWorkout.distance ?? undefined,
      endedAt: userWorkout.endedAt.toISOString(),
      workoutName: userWorkout.workoutName ?? undefined,
      workoutTypeId: userWorkout.workoutTypeId,
      workoutId: userWorkout.id,
      workoutTypeName: workout.name,
      periodId: userWorkout.periodId,
    };

    this.logger.info('eventData', { eventData });

    await this.eventarc.publish({
      type: WORKOUT_CREATED_EVENT,
      body: eventData,
    });
  }
}

export const appHandler = createPubSubHandler({
  handler: AppHandler,
  schema: () => WorkoutInputDto,
  topic: WORKOUT_PROCESSOR_QUEUE,
});
