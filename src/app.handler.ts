import { Injectable } from '@nestjs/common';
import { cfg, Drizzle, usr, wrk } from '@st-achievements/database';
import { getCorrelationId } from '@st-api/core';
import {
  createPubSubHandler,
  Eventarc,
  Logger,
  PubSubEventData,
  PubSubHandler,
} from '@st-api/firebase';
import dayjs from 'dayjs';
import { and, asc, eq, inArray, InferInsertModel, or, sql } from 'drizzle-orm';

import {
  WORKOUT_CREATED_EVENT,
  WORKOUT_PROCESSOR_QUEUE,
  WORKOUT_TYPE_OTHER_ID,
} from './app.constants.js';
import { WorkoutEventDto } from './workout-event.dto.js';
import { WorkoutInputDto } from './workout-input.dto.js';

@Injectable()
export class AppHandler implements PubSubHandler<typeof WorkoutInputDto> {
  constructor(
    private readonly eventarc: Eventarc,
    private readonly drizzle: Drizzle,
  ) {}

  private readonly logger = Logger.create(this);

  async handle(event: PubSubEventData<typeof WorkoutInputDto>): Promise<void> {
    this.logger.info({ event });

    if (!event.data.workouts.length) {
      this.logger.info(
        'Received an empty workouts array, nothing will be done',
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

    this.logger.info({ user });

    if (!user) {
      this.logger.warn(`username ${event.data.username} not found`);
      return;
    }

    const workoutsAlreadyCreated = await this.drizzle.query.usrWorkout.findMany(
      {
        where: inArray(
          usr.workout.externalId,
          event.data.workouts.map((workout) => workout.id),
        ),
        columns: {
          id: true,
          externalId: true,
        },
      },
    );

    this.logger.info({ workoutsAlreadyCreated });

    const externalIdsAlreadyCreated = workoutsAlreadyCreated.map(
      (workout) => workout.externalId,
    );

    this.logger.info({ externalIdsAlreadyCreated });

    if (externalIdsAlreadyCreated.length) {
      this.logger.info(
        `Workouts already created: ${externalIdsAlreadyCreated.join(', ')}`,
        {
          workouts: workoutsAlreadyCreated,
          externalIds: externalIdsAlreadyCreated,
        },
      );
    }

    const workoutsToBeCreated = event.data.workouts.filter(
      (workout) => !externalIdsAlreadyCreated.includes(workout.id),
    );

    this.logger.info({ workoutsToBeCreated });

    if (!workoutsToBeCreated.length) {
      this.logger.info('All workouts sent are already created');
      return;
    }

    const periodsConditions = workoutsToBeCreated.map((workout) => {
      const startAt = dayjs(workout.startTime).format('YYYY-MM-DD');
      return sql`${startAt} BETWEEN ${cfg.period.startAt} AND ${cfg.period.endAt}`;
    });

    const periods = await this.drizzle.query.cfgPeriod.findMany({
      where: and(eq(cfg.period.active, true), and(or(...periodsConditions))),
      orderBy: [asc(cfg.period.startAt), asc(cfg.period.endAt)],
      columns: {
        id: true,
        startAt: true,
        endAt: true,
      },
    });

    this.logger.info({ periods });

    const workoutTypes = await this.drizzle.query.wrkWorkoutType.findMany({
      where: and(
        eq(wrk.workoutType.active, true),
        and(
          or(
            inArray(wrk.workoutType.name, [
              ...new Set(
                workoutsToBeCreated.map(
                  (workout) => workout.workoutActivityType,
                ),
              ),
            ]),
            eq(wrk.workoutType.id, WORKOUT_TYPE_OTHER_ID),
          ),
        ),
      ),
      columns: {
        id: true,
        name: true,
      },
    });

    this.logger.info({ workoutTypes });

    const workoutsToBeInserted: InferInsertModel<typeof usr.workout>[] = [];

    const correlationId = getCorrelationId();

    const workoutTypeOther = workoutTypes.find(
      (workoutType) => workoutType.id === WORKOUT_TYPE_OTHER_ID,
    );

    for (const workout of workoutsToBeCreated) {
      const period = periods.find(({ startAt, endAt }) => {
        const date = dayjs(workout.startTime);
        const start = dayjs(startAt);
        const end = dayjs(endAt);
        return date.isAfter(start) && date.isBefore(end);
      });
      if (!period) {
        this.logger.warn(
          `${workout.id} - could not find period for ${dayjs(workout.startTime, 'YYYY-MM-DD')}`,
        );
        continue;
      }
      const workoutTypeFromEvent = workoutTypes.find(
        (workoutType) => workoutType.name === workout.workoutActivityType,
      );
      const workoutType = workoutTypeFromEvent ?? workoutTypeOther;
      if (!workoutType) {
        this.logger.warn(
          `${workout.id} - could not find workout type for ${workout.workoutActivityType} and also not found workout id = ${WORKOUT_TYPE_OTHER_ID}`,
        );
        continue;
      }
      workoutsToBeInserted.push({
        duration: workout.duration,
        externalId: workout.id,
        distance: workout.totalDistance,
        endedAt: workout.endTime,
        userId: user.id,
        startedAt: workout.startTime,
        energyBurned: workout.totalEnergyBurned,
        workoutName: workoutTypeFromEvent ? null : workout.workoutActivityType,
        workoutTypeId: workoutType.id,
        periodId: period.id,
        metadata: {
          correlationId,
        },
      });
    }

    if (!workoutsToBeInserted.length) {
      this.logger.warn(
        `All workouts received will not be created because of some validation. Check the logs prior to this one.`,
      );
      return;
    }

    this.logger.info({ workoutsToBeInserted });

    const insertedWorkouts = await this.drizzle
      .insert(usr.workout)
      .values(workoutsToBeInserted)
      .returning();

    this.logger.info({ insertedWorkouts });

    const eventsToBePublished = insertedWorkouts.map((userWorkout) => ({
      type: WORKOUT_CREATED_EVENT,
      body: {
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
        periodId: userWorkout.periodId,
      } satisfies WorkoutEventDto,
    }));

    this.logger.info('eventsToBePublished', { eventsToBePublished });

    await this.eventarc.publish(eventsToBePublished);

    this.logger.info(`All workouts created and published`);
  }
}

const LoggerContextSchema = WorkoutInputDto.pick({ username: true });

export const appHandler = createPubSubHandler({
  handler: AppHandler,
  schema: () => WorkoutInputDto,
  topic: WORKOUT_PROCESSOR_QUEUE,
  loggerContext: (event) => {
    const result = LoggerContextSchema.safeParse(event.data);
    if (result.success) {
      return `usr=${result.data.username}`;
    }
  },
});
