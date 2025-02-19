import { EventarcService, getAuthContext } from '@st-achievements/core';
import { cfg, Drizzle, usr, wrk } from '@st-achievements/database';
import { getCorrelationId } from '@st-api/core';
import {
  createPubSubHandler,
  Logger,
  PubSubEventData,
  PubSubHandler,
} from '@st-api/firebase';
import dayjs from 'dayjs';
import {
  and,
  asc,
  eq,
  inArray,
  InferInsertModel,
  isNull,
  or,
  sql,
} from 'drizzle-orm';

import {
  WORKOUT_CREATED_EVENT,
  WORKOUT_PROCESSOR_QUEUE,
  WORKOUT_TYPE_OTHER_ID,
} from './app.constants.js';
import { WorkoutEventDto } from './workout-event.dto.js';
import { WorkoutInputDto } from './workout-input.dto.js';
import { Injectable } from '@stlmpp/di';

@Injectable()
export class AppHandler implements PubSubHandler<typeof WorkoutInputDto> {
  constructor(
    private readonly eventarcService: EventarcService,
    private readonly drizzle: Drizzle,
  ) {}

  private readonly logger = Logger.create(this);

  async handle(event: PubSubEventData<typeof WorkoutInputDto>): Promise<void> {
    const { userId } = getAuthContext();
    Logger.setContext(`u${userId}`);

    this.logger.info('event', { event });

    if (!event.data.workouts.length) {
      this.logger.info(
        'Received an empty workouts array, nothing will be done',
      );
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

    this.logger.info('workoutsAlreadyCreated', { workoutsAlreadyCreated });

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

    this.logger.info('workoutsToBeCreated', { workoutsToBeCreated });

    if (!workoutsToBeCreated.length) {
      this.logger.info('All workouts sent are already created');
      return;
    }

    const periodsConditions = workoutsToBeCreated.map((workout) => {
      const startAt = dayjs(workout.startTime).format('YYYY-MM-DD');
      return sql`${startAt} BETWEEN ${cfg.period.startAt} AND ${cfg.period.endAt}`;
    });

    const periods = await this.drizzle.query.cfgPeriod.findMany({
      where: and(
        isNull(cfg.period.inactivatedAt),
        and(or(...periodsConditions)),
      ),
      orderBy: [asc(cfg.period.startAt), asc(cfg.period.endAt)],
      columns: {
        id: true,
        startAt: true,
        endAt: true,
      },
    });

    this.logger.info('periods', { periods });

    const workoutTypes = await this.drizzle.query.wrkWorkoutType.findMany({
      where: and(
        isNull(wrk.workoutType.inactivatedAt),
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

    this.logger.info('workoutTypes', { workoutTypes });

    const workoutsToBeInserted: InferInsertModel<typeof usr.workout>[] = [];

    const correlationId = getCorrelationId();

    const workoutTypeOther = workoutTypes.find(
      (workoutType) => workoutType.id === WORKOUT_TYPE_OTHER_ID,
    );

    for (const workout of workoutsToBeCreated) {
      const date = dayjs(workout.startTime);
      const period = periods.find(({ startAt, endAt }) => {
        const start = dayjs(startAt);
        const end = dayjs(endAt);
        return date.isAfter(start) && date.isBefore(end);
      });
      if (!period) {
        this.logger.warn(
          `${workout.id} - could not find period for ${date.format('YYYY-MM-DD')}`,
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
        userId,
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

    await this.eventarcService.publish(eventsToBePublished);

    this.logger.info('All workouts created and published');
  }
}

export const appHandler = createPubSubHandler({
  handler: AppHandler,
  schema: () => WorkoutInputDto,
  topic: WORKOUT_PROCESSOR_QUEUE,
});
